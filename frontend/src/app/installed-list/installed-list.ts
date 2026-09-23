import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { from, of } from 'rxjs';
import { catchError, concatMap, map } from 'rxjs/operators';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { IManagedOciContainer } from '../../shared/types';
import { CardGridComponent } from '../shared/components/card-grid/card-grid';
import { CertificateManagementDialog } from '../certificate-management/certificate-management-dialog';
import { UpgradeVersionDialog, UpgradeVersionDialogResult } from './upgrade-version-dialog';

// Container states that count as debris the user can purge in one click.
// `status` is a free-form pct string, so match case-insensitively.
const DELETABLE_STATES = new Set(['stopped', 'migrated']);

@Component({
  selector: 'app-installed-list',
  standalone: true,
  imports: [CommonModule, RouterModule, CardGridComponent, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './installed-list.html',
  styleUrl: './installed-list.scss',
})
export class InstalledList implements OnInit {
  installations: IManagedOciContainer[] = [];
  loading = true;
  error?: string;
  deleting = false;
  deleteStatus?: string;
  // Live progress of the sequential cleanup so the button can show "7/12".
  deleteProgress?: { done: number; total: number };

  private svc = inject(VeConfigurationService);
  private cacheService = inject(CacheService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private dialog = inject(MatDialog);
  veContextKey?: string;

  // Track by function — use hostname for host entries (vm_id=0)
  trackByInstallation = (_: number, item: IManagedOciContainer): string | number =>
    item.is_host ? `host:${item.hostname}` : item.vm_id;

  // DOM-id for each .card so UI tests can target a specific entry via
  // `#<hostname>` and reach its `.card-actions button` directly. Falls back
  // to `vm-<vm_id>` when hostname is absent (rare — host entries always
  // have a hostname, LXC entries usually do too).
  getCardIdForInstallation = (item: IManagedOciContainer): string => {
    const host = (item.hostname || '').trim();
    if (host) return host;
    return item.is_host ? 'pve-host' : `vm-${item.vm_id}`;
  };

  // Per-card class list — currently exposes the LXC status as
  // `status-<state>` so callers can identify each container's state with
  // `.card.status-running` / `.card.status-stopped` / … without parsing
  // text. Status values are sanitised (lowercased, non-alphanumeric → `-`)
  // because the raw value can be any pct-reported string.
  getCardClassesForInstallation = (item: IManagedOciContainer): string[] => {
    if (!item.status) return [];
    const slug = String(item.status).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug ? [`status-${slug}`] : [];
  };

  // Upgrade clones the *running* source, lets the clone pull the new image,
  // then hands the source's identity (IP, mountpoints) to the replacement. A
  // stopped (or otherwise non-running) source can't be cloned into a live
  // replacement, and a locked source fails deep in the pipeline — so the
  // Upgrade action is only offered for running, unlocked containers.
  canUpgrade = (item: IManagedOciContainer): boolean =>
    !item.lock && item.status === 'running';

  // Reason shown in the Upgrade button's tooltip; doubles as the disabled-state
  // explanation so the user knows what to fix (start the container / wait for
  // the lock to clear) instead of facing a dead button.
  upgradeTooltip = (item: IManagedOciContainer): string => {
    if (item.lock) return `Container is locked (pct ${item.lock}) — upgrade disabled until it clears`;
    if (item.status !== 'running') return 'Container must be running to upgrade — start it first';
    return 'Creates a new container with the latest image, then replaces the old one';
  };

  // Reconfigure clones the source the same way Upgrade does, so a non-running
  // container can't be reconfigured either. Host entries (is_host) are the
  // exception: a PVE host is configured in place, never cloned, so only its
  // lock state matters.
  canReconfigure = (item: IManagedOciContainer): boolean =>
    !item.lock && (!!item.is_host || item.status === 'running');

  reconfigureTooltip = (item: IManagedOciContainer): string => {
    if (item.lock) return `Container is locked (pct ${item.lock}) — reconfigure disabled until it clears`;
    if (!item.is_host && item.status !== 'running') return 'Container must be running to reconfigure — start it first';
    return 'Change addons / parameters and re-deploy';
  };

  ngOnInit(): void {
    this.veContextKey = this.route.snapshot.paramMap.get('veContextKey') ?? this.svc.getVeContextKey();
    this.loadInstallations();
  }

  private loadInstallations(): void {
    this.loading = true;
    this.cacheService.getInstallations().subscribe({
      next: (items) => {
        this.installations = items;
        this.loading = false;
      },
      error: () => {
        this.error = 'Error loading installations';
        this.loading = false;
      }
    });
  }

  // Real containers (never the synthetic PVE host) whose state marks them as
  // debris — the one-click cleanup targets exactly these. Locked containers are
  // included: the destroy script does `pct unlock` first.
  get deletableInstallations(): IManagedOciContainer[] {
    return this.installations.filter(
      (it) => !it.is_host && it.vm_id > 0 &&
        DELETABLE_STATES.has(String(it.status ?? '').toLowerCase()),
    );
  }

  // Destroy all stopped/migrated containers. No confirmation dialog by design —
  // the button carries the count and only appears when there's something to
  // purge, so the action is explicit at click time. Containers are destroyed
  // one at a time (each `pct destroy` is slow) so the button can show real
  // "N/total" progress instead of blocking silently until everything is done.
  deleteStoppedAndMigrated(): void {
    const targets = this.deletableInstallations;
    if (this.deleting || targets.length === 0) return;

    this.deleting = true;
    this.deleteStatus = undefined;
    const vmIds = targets.map((it) => it.vm_id);
    this.deleteProgress = { done: 0, total: vmIds.length };

    const destroyed: number[] = [];
    const failed: number[] = [];

    from(vmIds)
      .pipe(
        concatMap((vmId) =>
          this.svc.destroyInstallations([vmId]).pipe(
            map((result) => ({ vmId, ok: (result.failed?.length ?? 0) === 0 })),
            // A network/HTTP error must not abort the remaining deletions —
            // record this one as failed and carry on with the next container.
            catchError(() => of({ vmId, ok: false })),
          ),
        ),
      )
      .subscribe({
        next: ({ vmId, ok }) => {
          (ok ? destroyed : failed).push(vmId);
          if (ok) {
            // Drop the destroyed container's card right away for live feedback;
            // failed ones stay visible so the user sees what's stuck.
            this.installations = this.installations.filter((it) => it.vm_id !== vmId);
          }
          if (this.deleteProgress) this.deleteProgress.done++;
        },
        complete: () => {
          this.deleting = false;
          this.deleteProgress = undefined;
          this.deleteStatus = failed.length > 0
            ? `${destroyed.length} gelöscht, ${failed.length} fehlgeschlagen: ${failed.join(', ')}`
            : `${destroyed.length} Container gelöscht`;
          // Force a fresh list — the destroyed containers must disappear.
          this.cacheService.invalidate();
          this.loadInstallations();
        },
      });
  }

  startUpgrade(installation: IManagedOciContainer) {
    // Defensive guard: the button is disabled for non-running/locked sources,
    // but a stale cached status could still let a click through. Never dispatch
    // an upgrade against a source that can't be cloned into a live replacement.
    if (!this.canUpgrade(installation)) return;

    const dialogRef = this.dialog.open(UpgradeVersionDialog, {
      width: '500px',
      data: { installation },
    });

    dialogRef.afterClosed().subscribe((result?: UpgradeVersionDialogResult) => {
      if (!result) return; // User cancelled

      const application = installation.application_id || 'proxvex';
      this.svc.postVeUpgrade(application, {
        previous_vm_id: installation.vm_id,
        oci_image: installation.oci_image,
        application_id: installation.application_id,
        application_name: installation.application_name,
        version: installation.version,
        addons: installation.addons,
        target_versions: result.target_versions,
      }).subscribe({
        next: () => {
          this.router.navigate(['/monitor']);
        },
        error: () => {
          this.error = 'Error starting upgrade';
        },
      });
    });
  }

  editAddons(installation: IManagedOciContainer) {
    // Defensive guard mirroring the disabled button — never start a reconfigure
    // against a non-running (or locked) container, which can't be cloned.
    if (!this.canReconfigure(installation)) return;

    // Build query params
    const queryParams: Record<string, string | number | undefined> = {
      mode: 'addon',
      application_id: installation.application_id,
      application_name: installation.application_name,
      oci_image: installation.oci_image,
      installed_addons: installation.addons?.join(',') || undefined,
      // Host entries (e.g. Proxmox) have no vm_id
      ...(installation.is_host
        ? { is_host: 'true', hostname: installation.hostname }
        : { previous_vm_id: installation.vm_id }),
    };

    // Filter out undefined values
    const filteredParams = Object.fromEntries(
      Object.entries(queryParams).filter(([, v]) => v !== undefined)
    );
    this.router.navigate(['/applications'], { queryParams: filteredParams });
  }

  openCertificateManagement(): void {
    this.dialog.open(CertificateManagementDialog, {
      width: '800px',
      maxHeight: '90vh',
    });
  }
}
