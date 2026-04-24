#!/usr/bin/env node
import { TemplateProcessor } from "./templateprocessor.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { DocumentationPathResolver } from "../documentation-path-resolver.mjs";
import { TemplatePathResolver } from "./template-path-resolver.mjs";
import type {
  IApplication,
  IVEContext,
  IConfiguredPathes,
} from "../backend-types.mjs";
import type { ITemplate, ICommand, TaskType } from "../types.mjs";
import type { ITemplateReference } from "../backend-types.mjs";

/**
 * Analyzes templates (skip status, conditional status, usage).
 */
export class TemplateAnalyzer {
  private pathResolver: DocumentationPathResolver;
  private configuredPathes: IConfiguredPathes;

  constructor(
    pathResolver: DocumentationPathResolver,
    configuredPathes: IConfiguredPathes,
  ) {
    this.pathResolver = pathResolver;
    this.configuredPathes = configuredPathes;
  }

  /**
   * Checks if template is conditionally executed (has skip_if_all_missing or skip_if_property_set flag).
   */
  isConditionallyExecuted(templateData: ITemplate): boolean {
    return !!(
      (templateData.skip_if_all_missing &&
        templateData.skip_if_all_missing.length > 0) ||
      templateData.skip_if_property_set
    );
  }

  /**
   * Checks if a template is fully skipped by checking if all its commands are skipped.
   */
  isTemplateSkipped(
    templateName: string,
    applicationId: string,
    commands: ICommand[],
    category: string,
  ): boolean {
    const repositories = PersistenceManager.getInstance().getRepositories();
    const templateRef = repositories.resolveTemplateRef(
      applicationId,
      templateName,
      category,
    );
    const templateData = templateRef
      ? repositories.getTemplate(templateRef)
      : null;
    if (!templateData) {
      return false; // Template not found, can't determine skip status
    }

    // Get command names and script names from template
    const templateCommandNames = new Set<string>();
    const templateScriptNames = new Set<string>();
    if (templateData.commands && Array.isArray(templateData.commands)) {
      for (const cmd of templateData.commands) {
        if (cmd && cmd.name) {
          templateCommandNames.add(cmd.name);
        }
        if (cmd && cmd.script) {
          // Extract script name without path and extension
          const scriptName = cmd.script
            .replace(/^.*\//, "")
            .replace(/\.sh$/, "");
          templateScriptNames.add(scriptName);
        }
      }
    }

    // If template has no command names but has a template name, use template name
    // This handles cases where commands don't have explicit names
    if (templateCommandNames.size === 0 && templateData.name) {
      templateCommandNames.add(templateData.name);
    }

    // If template has no commands or scripts, it can't be skipped
    if (templateCommandNames.size === 0 && templateScriptNames.size === 0) {
      return false;
    }

    // Find matching commands in loaded commands
    const matchingCommands: ICommand[] = [];
    for (const cmd of commands) {
      if (!cmd || !cmd.name) continue;

      // Check if command name matches (with or without "(skipped)" suffix)
      const cmdBaseName = cmd.name.replace(/\s*\(skipped\)$/, "");
      if (templateCommandNames.has(cmdBaseName)) {
        matchingCommands.push(cmd);
      } else if (templateScriptNames.size > 0) {
        // If no command name match, try to match by script name
        // Check if command description or name contains script name
        const cmdDescription = (cmd.description || "").toLowerCase();
        const cmdNameLower = cmdBaseName.toLowerCase();
        for (const scriptName of templateScriptNames) {
          const scriptNameLower = scriptName.toLowerCase();
          // Match if script name appears in command name or description
          if (
            cmdNameLower.includes(scriptNameLower) ||
            cmdDescription.includes(scriptNameLower)
          ) {
            matchingCommands.push(cmd);
            break;
          }
        }
      }
    }

    // Determine expected count: use command names if available, otherwise script names
    const expectedCount =
      templateCommandNames.size > 0
        ? templateCommandNames.size
        : templateScriptNames.size;

    // If we found commands for this template, check if all are skipped
    // Important: Only mark as skipped if we found ALL commands and ALL are skipped
    if (
      matchingCommands.length > 0 &&
      matchingCommands.length === expectedCount
    ) {
      const allSkipped = matchingCommands.every((cmd) =>
        cmd.name?.includes("(skipped)"),
      );
      return allSkipped;
    }

    // If we didn't find all commands, the template might not have been executed
    // or some commands might be missing - don't mark as skipped
    return false;
  }

  /**
   * Finds all applications that use a specific template (excluding skipped ones).
   */
  async findApplicationsUsingTemplate(templateName: string): Promise<string[]> {
    const usingApplications: string[] = [];

    try {
      const pm = PersistenceManager.getInstance();
      const storageContext = pm.getContextManager();
      const repositories = pm.getRepositories();
      const allApps = pm.getApplicationService().getAllAppNames();

      // Normalize template name (remove .json extension)
      const normalizedTemplate =
        this.pathResolver.normalizeTemplateName(templateName);

      for (const [appName] of allApps) {
        try {
          const appData: IApplication = repositories.getApplication(appName);

          // Check if template is used and not skipped
          const installationTemplates = this.getInstallationTemplates(appData);
          if (installationTemplates.length > 0) {
            let templateFound = false;
            let foundCategory = "";

            // First, check if template is directly in installation list
            for (const { ref: templateRef, category } of installationTemplates) {
              const refTemplateName =
                typeof templateRef === "string"
                  ? templateRef
                  : (templateRef as ITemplateReference).name;

              const normalizedRef =
                this.pathResolver.normalizeTemplateName(refTemplateName);

              if (normalizedRef === normalizedTemplate) {
                templateFound = true;
                foundCategory = category;
                break;
              }
            }

            // Also check referenced templates
            if (!templateFound) {
              for (const { ref: templateRef, category } of installationTemplates) {
                const refTemplateName =
                  typeof templateRef === "string"
                    ? templateRef
                    : (templateRef as ITemplateReference).name;

                const resolvedTemplateRef = repositories.resolveTemplateRef(
                  appName,
                  refTemplateName,
                  category,
                );
                const templateData = resolvedTemplateRef
                  ? repositories.getTemplate(resolvedTemplateRef)
                  : null;
                if (templateData) {
                  // Check if this template references the target template
                  const referencedTemplates =
                    TemplatePathResolver.extractTemplateReferences(
                      templateData,
                    );
                  for (const refTemplateName of referencedTemplates) {
                    const cmdTemplateName =
                      this.pathResolver.normalizeTemplateName(refTemplateName);
                    if (cmdTemplateName === normalizedTemplate) {
                      templateFound = true;
                      foundCategory = category;
                      break;
                    }
                  }
                  if (templateFound) break;
                }

                if (templateFound) break;
              }
            }

            // If template is found, check if it's skipped
            if (templateFound) {
              // Load application commands to check if template is skipped
              try {
                const templateProcessor = new TemplateProcessor(
                  {
                    jsonPath: this.configuredPathes.jsonPath,
                    localPath: this.configuredPathes.localPath,
                    schemaPath: this.configuredPathes.schemaPath,
                  },
                  storageContext,
                  pm.getPersistence(),
                );

                const dummyVeContext: IVEContext = {
                  host: "dummy",
                  port: 22,
                  getStorageContext: () => storageContext,
                  getKey: () => "ve_dummy",
                };

                const loaded = await templateProcessor.loadApplication(
                  appName,
                  "installation" as TaskType,
                  dummyVeContext,
                );

                const commands = loaded.commands || [];

                // Check if template is skipped using the same logic as in generateApplicationReadme
                if (
                  !this.isTemplateSkipped(normalizedTemplate, appName, commands, foundCategory)
                ) {
                  usingApplications.push(appName);
                }
              } catch {
                // If loading fails, include the application anyway (better to show than hide)
                usingApplications.push(appName);
              }
            }
          }
        } catch {
          // Ignore errors reading application
        }
      }
    } catch {
      // Ignore errors
    }

    // Remove duplicates and sort
    return [...new Set(usingApplications)].sort();
  }

  /**
   * Extracts a flat list of templates from the installation object.
   * Installation format: { image: [...], pre_start: [...], start: [...], post_start: [...] }
   */
  private getInstallationTemplates(appData: IApplication): { ref: string | ITemplateReference; category: string }[] {
    const installation = (appData as any).installation;
    if (!installation || typeof installation !== "object") {
      return [];
    }

    const templates: { ref: string | ITemplateReference; category: string }[] = [];
    const categories = ["image", "pre_start", "pre_start_finalize", "start", "post_start"];

    for (const category of categories) {
      const list = installation[category];
      if (Array.isArray(list)) {
        for (const item of list) {
          templates.push({ ref: item, category });
        }
      }
    }

    return templates;
  }
}
