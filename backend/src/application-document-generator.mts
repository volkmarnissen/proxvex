#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ApplicationLoader } from "./apploader.mjs";
import {
  VEConfigurationError,
  IApplication,
  IConfiguredPathes,
  IReadApplicationOptions,
  ITemplateReference,
} from "./backend-types.mjs";
import { DocumentationPathResolver } from "./documentation-path-resolver.mjs";
import { TemplateAnalyzer } from "./templates/template-analyzer.mjs";
import { TemplatePathResolver } from "./templates/template-path-resolver.mjs";
import type { IParameter, ICommand, ITemplate } from "./types.mjs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import { FileSystemPersistence } from "./persistence/filesystem-persistence.mjs";

/**
 * Generates Markdown documentation for applications.
 */
export class ApplicationDocumentGenerator {
  private pathResolver: DocumentationPathResolver;
  private templateAnalyzer: TemplateAnalyzer;
  private htmlPath: string;
  private configuredPathes: IConfiguredPathes;

  constructor(
    pathResolver: DocumentationPathResolver,
    templateAnalyzer: TemplateAnalyzer,
    htmlPath: string,
    configuredPathes: IConfiguredPathes,
  ) {
    this.pathResolver = pathResolver;
    this.templateAnalyzer = templateAnalyzer;
    this.htmlPath = htmlPath;
    this.configuredPathes = configuredPathes;
  }

  /**
   * Generates README.md content for an application.
   */
  generateReadme(
    applicationName: string,
    appData: IApplication,
    parentApp: IApplication | null,
    appPath: string,
    commands: ICommand[] = [],
    skippedTemplates: Set<string> = new Set(),
  ): string {
    const lines: string[] = [];

    // Title
    lines.push(`# ${appData.name || applicationName}`);
    lines.push("");

    // Description
    if (appData.description) {
      lines.push(appData.description);
      lines.push("");
    }

    // Parent Application
    if (parentApp) {
      lines.push(`## Parent Application`);
      lines.push("");
      lines.push(
        `This application extends [${parentApp.name || appData.extends}](../${appData.extends}/README.md).`,
      );
      lines.push("");
    }

    // Installation Templates
    const installationTemplates = this.getInstallationTemplates(appData);
    if (installationTemplates.length > 0) {
      lines.push("## Installation Templates");
      lines.push("");
      lines.push(
        "The following templates are executed in order during installation:",
      );
      lines.push("");
      lines.push("| Template | Description | Status |");
      lines.push("|----------|-------------|--------|");

      for (const templateRef of installationTemplates) {
        const templateName =
          typeof templateRef === "string"
            ? templateRef
            : (templateRef as ITemplateReference).name;

        const resolved = this.pathResolver.resolveTemplatePath(
          templateName,
          appPath,
        );
        const isShared = resolved?.isShared ?? true;
        const isLocal = !isShared;

        const templateDocName =
          this.pathResolver.getTemplateDocName(templateName);
        const templateDocPath = isLocal
          ? `json/applications/${applicationName}/templates/${templateDocName}`
          : `json/shared/templates/${templateDocName}`;

        // Try to read template for description
        let description = "";
        let referencedTemplates: string[] = [];
        const templateData = this.pathResolver.loadTemplate(
          templateName,
          appPath,
        );
        if (templateData) {
          description = templateData.description || "";
          // Take only the first sentence (before first period or newline) for table readability
          const firstSentenceMatch = description.match(/^([^.\n]+)/);
          if (firstSentenceMatch && firstSentenceMatch[1]) {
            description = firstSentenceMatch[1].trim();
          }
          // Replace pipes in description to avoid breaking the table
          description = description.replace(/\|/g, "&#124;");
          // Limit description length to avoid very long table cells
          if (description.length > 80) {
            description = description.substring(0, 77) + "...";
          }

          // Extract referenced templates from commands
          referencedTemplates =
            TemplatePathResolver.extractTemplateReferences(templateData);
        }

        // Check if template is fully skipped
        const isFullySkipped = skippedTemplates.has(templateName);

        // Check if template is conditionally executed
        const isConditionallyExecuted = templateData
          ? this.templateAnalyzer.isConditionallyExecuted(templateData)
          : false;

        // Format status with color highlighting
        const status = this.formatTemplateStatus(
          isFullySkipped,
          isConditionallyExecuted,
        );

        lines.push(
          `| [${templateName}](${templateDocPath}) | ${description} | ${status} |`,
        );

        // Add referenced templates as indented rows
        for (const refTemplateName of referencedTemplates) {
          const refResolved = this.pathResolver.resolveTemplatePath(
            refTemplateName,
            appPath,
          );
          const refIsShared = refResolved?.isShared ?? true;

          const refTemplateData = this.pathResolver.loadTemplate(
            refTemplateName,
            appPath,
          );
          let refDescription = "";
          if (refTemplateData) {
            refDescription = refTemplateData.description || "";
            const firstSentenceMatch = refDescription.match(/^([^.\n]+)/);
            if (firstSentenceMatch && firstSentenceMatch[1]) {
              refDescription = firstSentenceMatch[1].trim();
            }
            refDescription = refDescription.replace(/\|/g, "&#124;");
            if (refDescription.length > 70) {
              refDescription = refDescription.substring(0, 67) + "...";
            }
          }

          const refTemplateDocName =
            this.pathResolver.getTemplateDocName(refTemplateName);
          const refTemplateDocPath = refIsShared
            ? `json/shared/templates/${refTemplateDocName}`
            : `json/applications/${applicationName}/templates/${refTemplateDocName}`;

          // Check if referenced template is fully skipped or conditionally executed
          const refIsFullySkipped = skippedTemplates.has(refTemplateName);
          const refIsConditionallyExecuted = refTemplateData
            ? this.templateAnalyzer.isConditionallyExecuted(refTemplateData)
            : false;
          const refStatus = this.formatTemplateStatus(
            refIsFullySkipped,
            refIsConditionallyExecuted,
          );

          lines.push(
            `| └─ [${refTemplateName}](${refTemplateDocPath}) | ${refDescription} | ${refStatus} |`,
          );
        }
      }
      lines.push("");
    }

    // Generated Parameters Section
    lines.push("<!-- GENERATED_START:PARAMETERS -->");
    lines.push("## Parameters");
    lines.push("");
    lines.push(
      "The following parameters can be configured for this application:",
    );
    lines.push("");

    // Get parameters from set-parameters.json if it exists
    const setParamsPath = path.join(
      appPath,
      "templates",
      "set-parameters.json",
    );
    if (fs.existsSync(setParamsPath)) {
      const setParamsData: ITemplate = JSON.parse(
        fs.readFileSync(setParamsPath, "utf-8"),
      );
      if (setParamsData.parameters) {
        lines.push(this.generateParametersTable(setParamsData.parameters));
        lines.push("");
      }
    }

    lines.push("<!-- GENERATED_END:PARAMETERS -->");
    lines.push("");

    // Installation Commands
    if (commands.length > 0) {
      lines.push("<!-- GENERATED_START:COMMANDS -->");
      lines.push("## Installation Commands");
      lines.push("");
      lines.push(
        "The following commands are executed during installation (in order):",
      );
      lines.push("");
      lines.push("| # | Command | Description | Status |");
      lines.push("|---|---------|-------------|--------|");

      let commandIndex = 1;
      for (const cmd of commands) {
        if (!cmd) continue;

        const isSkipped = cmd.name?.includes("(skipped)") || false;
        const commandName = cmd.name || "Unnamed command";
        const description = cmd.description || "-";
        const status = isSkipped ? "⏭️ Skipped" : "✓ Executed";

        lines.push(
          `| ${commandIndex} | \`${commandName}\` | ${description} | ${status} |`,
        );
        commandIndex++;
      }
      lines.push("");
      lines.push("<!-- GENERATED_END:COMMANDS -->");
      lines.push("");
    }

    // Features
    lines.push("## Features");
    lines.push("");
    lines.push(
      "This application provides the following features (documented in individual template files):",
    );
    lines.push("");

    // List features from templates
    for (const templateRef of installationTemplates) {
      const templateName =
        typeof templateRef === "string"
          ? templateRef
          : (templateRef as ITemplateReference).name;

      const resolved = this.pathResolver.resolveTemplatePath(
        templateName,
        appPath,
      );
      if (resolved) {
        const templateDocName =
          this.pathResolver.getTemplateDocName(templateName);
        const templateDocPath = resolved.isShared
          ? `json/shared/templates/${templateDocName}`
          : `json/applications/${applicationName}/templates/${templateDocName}`;
        lines.push(`- See [${templateName}](${templateDocPath}) for details`);
      }
    }
    lines.push("");

    return lines.join("\n");
  }

  /**
   * Generates a markdown table for parameters.
   */
  private generateParametersTable(parameters: IParameter[]): string {
    const lines: string[] = [];
    lines.push("| Parameter | Type | Required | Default | Description |");
    lines.push("|-----------|------|----------|---------|-------------|");

    for (const param of parameters) {
      const type = param.type || "string";
      const required = param.required ? "Yes" : "No";
      const defaultVal =
        param.default !== undefined ? String(param.default) : "-";
      const description = param.description || "";

      // Add flags
      const flags: string[] = [];
      if (param.secure) flags.push("🔒 Secure");
      if (param.advanced) flags.push("⚙️ Advanced");
      if (param.upload) flags.push("📤 Upload");
      const flagsStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";

      lines.push(
        `| \`${param.id}\` | ${type} | ${required} | ${defaultVal} | ${description}${flagsStr} |`,
      );
    }

    return lines.join("\n");
  }

  /**
   * Extracts a flat list of templates from the installation object.
   * Installation format: { image: [...], pre_start: [...], start: [...], post_start: [...] }
   */
  private getInstallationTemplates(appData: IApplication): (string | ITemplateReference)[] {
    const installation = (appData as any).installation;
    if (!installation || typeof installation !== "object") {
      return [];
    }

    const templates: (string | ITemplateReference)[] = [];
    const categories = ["image", "pre_start", "pre_start_finalize", "start", "post_start"];

    for (const category of categories) {
      const list = installation[category];
      if (Array.isArray(list)) {
        templates.push(...list);
      }
    }

    return templates;
  }

  /**
   * Formats template status for markdown table.
   */
  private formatTemplateStatus(
    isFullySkipped: boolean,
    isConditionallyExecuted: boolean,
  ): string {
    if (isFullySkipped) {
      return '<span style="color: #ff6b6b; font-weight: bold;">⏭️ All Commands Skipped</span>';
    } else if (isConditionallyExecuted) {
      return '<span style="color: #ffa500; font-weight: bold;">⚙️ Conditional (requires parameters)</span>';
    } else {
      return "✓ Executed";
    }
  }

  /**
   * Gets parent application data.
   */
  async getParentApplication(parentName: string): Promise<IApplication | null> {
    try {
      const pm = PersistenceManager.getInstance();
      const persistence = new FileSystemPersistence(
        {
          jsonPath: this.configuredPathes.jsonPath,
          localPath: this.configuredPathes.localPath,
          schemaPath: this.configuredPathes.schemaPath,
        },
        pm.getJsonValidator(),
      );
      const appLoader = new ApplicationLoader(
        {
          jsonPath: this.configuredPathes.jsonPath,
          localPath: this.configuredPathes.localPath,
          schemaPath: this.configuredPathes.schemaPath,
        },
        persistence,
      );

      const readOpts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", parentName),
        taskTemplates: [],
      };

      return appLoader.readApplicationJson(parentName, readOpts);
    } catch {
      return null;
    }
  }
}
