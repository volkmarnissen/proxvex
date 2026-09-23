import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstalledList } from './installed-list';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ensureAngularTesting } from '../../test-setup';
import type { IInstallationsResponse } from '../../shared/types';

const mockInstallations: IInstallationsResponse = [
  {
    vm_id: 101,
    hostname: 'cont-01',
    oci_image: 'ghcr.io/acme/app-alpha:1.2.3',
    icon: '',
  },
  {
    vm_id: 104,
    hostname: 'cont-02',
    oci_image: 'ghcr.io/acme/app-beta:4.5.6',
    icon: '',
  },
];

class MockVeConfigurationService {
  getVeContextKey = vi.fn(() => 've_testhost');
  getInstallations = vi.fn(() => of<IInstallationsResponse>(mockInstallations));
  getInstallationVersions = vi.fn(() => of({ services: [], framework: 'oci-image' }));
  postVeUpgrade = vi.fn(() => of({ success: true, restartKey: 'rk_test' }));
  destroyInstallations = vi.fn(() => of({ destroyed: [], failed: [] }));
}

class MockCacheService {
  getInstallations = vi.fn(() => of(mockInstallations));
  invalidate = vi.fn();
}

// Ensure Angular testing environment is active (without deprecated imports in spec)
ensureAngularTesting();

describe('InstalledList component (vitest)', () => {
  let svc: MockVeConfigurationService;
  let cacheService: MockCacheService;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InstalledList],
      providers: [
        provideRouter([]),
        { provide: VeConfigurationService, useClass: MockVeConfigurationService },
        { provide: CacheService, useClass: MockCacheService },
      ],
    }).compileComponents();

    svc = TestBed.inject(VeConfigurationService) as unknown as MockVeConfigurationService;
    cacheService = TestBed.inject(CacheService) as unknown as MockCacheService;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate');
  });

  it('loads two installations and renders two cards', async () => {
    const fixture = TestBed.createComponent(InstalledList);
    fixture.detectChanges();

    // Expect: getInstallations was called on CacheService
    expect(cacheService.getInstallations).toHaveBeenCalledTimes(1);

    const el: HTMLElement = fixture.nativeElement as HTMLElement;
    // 2 installation cards should be rendered (each has action buttons)
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.card-actions button'));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  describe('Upgrade / Reconfigure availability', () => {
    let cmp: InstalledList;
    beforeEach(() => {
      cmp = TestBed.createComponent(InstalledList).componentInstance;
    });

    it('allows upgrade only for running, unlocked containers', () => {
      expect(cmp.canUpgrade({ vm_id: 1, oci_image: 'x', status: 'running' })).toBe(true);
      expect(cmp.canUpgrade({ vm_id: 1, oci_image: 'x', status: 'stopped' })).toBe(false);
      expect(cmp.canUpgrade({ vm_id: 1, oci_image: 'x' })).toBe(false); // status undefined
      expect(cmp.canUpgrade({ vm_id: 1, oci_image: 'x', status: 'running', lock: 'migrate' })).toBe(false);
    });

    it('blocks reconfigure for stopped containers but always allows it for hosts', () => {
      expect(cmp.canReconfigure({ vm_id: 1, oci_image: 'x', status: 'running' })).toBe(true);
      expect(cmp.canReconfigure({ vm_id: 1, oci_image: 'x', status: 'stopped' })).toBe(false);
      // Host entries are configured in place (never cloned) → status is irrelevant.
      expect(cmp.canReconfigure({ vm_id: 0, oci_image: '', is_host: true })).toBe(true);
      // …but a locked host is still off-limits.
      expect(cmp.canReconfigure({ vm_id: 0, oci_image: '', is_host: true, lock: 'backup' })).toBe(false);
    });

    it('explains the disabled reason in the tooltip', () => {
      expect(cmp.upgradeTooltip({ vm_id: 1, oci_image: 'x', status: 'stopped' })).toContain('must be running');
      expect(cmp.upgradeTooltip({ vm_id: 1, oci_image: 'x', status: 'running', lock: 'migrate' })).toContain('locked');
      expect(cmp.reconfigureTooltip({ vm_id: 1, oci_image: 'x', status: 'stopped' })).toContain('must be running');
    });

    it('does not dispatch an upgrade for a stopped container', () => {
      cmp.startUpgrade({ vm_id: 1, oci_image: 'x', status: 'stopped' });
      expect(svc.postVeUpgrade).not.toHaveBeenCalled();
    });

    it('disables the Upgrade button in the DOM when the container is not running', async () => {
      cacheService.getInstallations = vi.fn(() =>
        of([{ vm_id: 9, hostname: 'down-01', oci_image: 'ghcr.io/acme/x:1', icon: '', status: 'stopped' }]),
      );
      const fixture = TestBed.createComponent(InstalledList);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const upgradeBtn = Array.from(el.querySelectorAll<HTMLButtonElement>('.card-actions button')).find(
        (b) => b.textContent?.trim() === 'Upgrade',
      );
      expect(upgradeBtn?.disabled).toBe(true);
    });
  });

  describe('Cleanup of stopped/migrated containers', () => {
    it('lists only non-running real containers as deletable', () => {
      const cmp = TestBed.createComponent(InstalledList).componentInstance;
      cmp.installations = [
        { vm_id: 0, oci_image: '', is_host: true, status: 'running' },
        { vm_id: 101, oci_image: 'x', status: 'running' },
        { vm_id: 102, oci_image: 'x', status: 'stopped' },
        { vm_id: 103, oci_image: 'x', status: 'Migrated' }, // case-insensitive
      ];
      const ids = cmp.deletableInstallations.map((i) => i.vm_id);
      expect(ids).toEqual([102, 103]);
    });

    it('destroys the deletable vmIds one at a time and drops each card live', () => {
      const fixture = TestBed.createComponent(InstalledList);
      const cmp = fixture.componentInstance;
      // Record how many containers are still present at each request — since the
      // deletes run sequentially and each ok card is removed immediately, the
      // 2nd request must see one fewer container than the 1st.
      const sizeAtCall: number[] = [];
      svc.destroyInstallations = vi.fn((ids: number[]) => {
        sizeAtCall.push(cmp.installations.length);
        return of({ destroyed: [`${ids[0]}@h`], failed: [] });
      });
      // Server truth after both deletes: only the running one remains.
      cacheService.getInstallations = vi.fn(() =>
        of([{ vm_id: 101, oci_image: 'x', status: 'running' }]),
      );
      cmp.installations = [
        { vm_id: 101, oci_image: 'x', status: 'running' },
        { vm_id: 102, oci_image: 'x', status: 'stopped' },
        { vm_id: 103, oci_image: 'x', status: 'migrated' },
      ];

      cmp.deleteStoppedAndMigrated();

      // One request per container, not one bulk call
      expect(svc.destroyInstallations).toHaveBeenNthCalledWith(1, [102]);
      expect(svc.destroyInstallations).toHaveBeenNthCalledWith(2, [103]);
      expect(sizeAtCall).toEqual([3, 2]); // card removed live between requests
      expect(cacheService.invalidate).toHaveBeenCalledTimes(1);
      expect(cmp.deleting).toBe(false);
      expect(cmp.deleteProgress).toBeUndefined();
      expect(cmp.deleteStatus).toContain('2 Container gelöscht');
    });

    it('keeps failed containers visible and reports them in the status', () => {
      const fixture = TestBed.createComponent(InstalledList);
      const cmp = fixture.componentInstance;
      // 102 fails server-side (failed[] non-empty), 103 succeeds.
      svc.destroyInstallations = vi.fn((ids: number[]) =>
        ids[0] === 102
          ? of({ destroyed: [], failed: [{ vmid: 102, ve_host: 'h', error: 'boom' }] })
          : of({ destroyed: ['103@h'], failed: [] }),
      );
      // Server truth after: the failed 102 still exists, 103 is gone.
      cacheService.getInstallations = vi.fn(() =>
        of([{ vm_id: 102, oci_image: 'x', status: 'stopped' }]),
      );
      cmp.installations = [
        { vm_id: 102, oci_image: 'x', status: 'stopped' },
        { vm_id: 103, oci_image: 'x', status: 'migrated' },
      ];

      cmp.deleteStoppedAndMigrated();

      expect(cmp.installations.map((i) => i.vm_id)).toEqual([102]);
      expect(cmp.deleteStatus).toContain('1 gelöscht');
      expect(cmp.deleteStatus).toContain('fehlgeschlagen: 102');
    });

    it('does nothing when there is nothing to delete', () => {
      const cmp = TestBed.createComponent(InstalledList).componentInstance;
      cmp.installations = [{ vm_id: 101, oci_image: 'x', status: 'running' }];
      cmp.deleteStoppedAndMigrated();
      expect(svc.destroyInstallations).not.toHaveBeenCalled();
    });
  });
});
