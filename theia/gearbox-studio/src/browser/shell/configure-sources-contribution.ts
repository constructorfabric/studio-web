// Constructor Studio: this machine's own gears checkout, for a catalogue with
// no Studio server behind it.
//
// From Gearbox Studio's first-run setup (constructorfabric/gearbox#14), which
// asks for a checkout -- or clones one -- and keeps it in the settings. Here the
// window's folder and the corpus Studio lists stay the usual way to the gears,
// so nothing asks at start: the command is in the palette, and the Catalogue
// offers it when it has no gears and no server to list them
// (`catalogue-widget.tsx`). What it saves is `gearbox.sourceRoots`, which the
// catalogue hands the backend before each load (`CatalogueStore`).

import { AbstractDialog, DialogProps } from "@theia/core/lib/browser";
import { CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { PreferenceScope } from "@theia/core/lib/common/preferences/preference-scope";
import { PreferenceService } from "@theia/core/lib/common/preferences/preference-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileDialogService } from "@theia/filesystem/lib/browser";

import {
  configuredSourceRoots,
  GEARBOX_SOURCE_REPOSITORY,
  GEARBOX_SOURCE_ROOTS,
} from "../../common/gearbox-preferences";
import { GearboxService } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";

export const CONFIGURE_SOURCES = {
  id: "gearbox.sources.configure",
  label: "Gearbox: Configure Sources",
};

type SourceChoice = "choose" | "clone";

/** Two ways to a gears checkout, and a way out. */
class SourceChoiceDialog extends AbstractDialog<SourceChoice | undefined> {
  protected choice: SourceChoice | undefined;

  constructor(repository: string, configured: readonly string[]) {
    super({ title: "Gears on this machine" } satisfies DialogProps);
    const text = document.createElement("div");
    text.className = "gbx-first-run";
    const lead = document.createElement("p");
    lead.textContent =
      "The catalogue can also read a local checkout of a gears repository -- for working " +
      "without a Studio server, or with gears of your own. Choose the checkout you have, or clone one.";
    text.append(lead);
    if (configured.length > 0) {
      const now = document.createElement("p");
      now.textContent = `Read now: ${configured.join(", ")}`;
      text.append(now);
    }
    const repo = document.createElement("p");
    repo.textContent = `Repository: ${repository}`;
    repo.className = "gbx-first-run-repository";
    text.append(repo);
    this.contentNode.appendChild(text);

    this.appendCloseButton("Cancel");
    const clone = this.createButton("Clone…");
    clone.classList.add("secondary");
    this.controlPanel.appendChild(clone);
    this.addEventListener(clone, "click", () => this.pick("clone"));
    const choose = this.appendAcceptButton("Choose checkout…");
    this.addEventListener(choose, "click", () => this.pick("choose"));
  }

  protected pick(choice: SourceChoice): void {
    this.choice = choice;
    void this.accept();
  }

  get value(): SourceChoice | undefined {
    return this.choice;
  }
}

@injectable()
export class ConfigureSourcesContribution implements CommandContribution {
  @inject(PreferenceService) protected readonly preferences!: PreferenceService;
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(CONFIGURE_SOURCES, { execute: () => this.run() });
  }

  /** Ask for a gears checkout, add it to the settings, and load the catalogue again. */
  async run(): Promise<void> {
    await this.preferences.ready;
    const repository = this.preferences.get<string>(GEARBOX_SOURCE_REPOSITORY, "");
    const configured = configuredSourceRoots(this.preferences);
    const choice = await new SourceChoiceDialog(repository, configured).open();
    if (choice === undefined) return;

    const root = choice === "choose" ? await this.pickFolder("Choose the gears checkout") : await this.clone(repository);
    if (root === undefined) return;

    if (!configured.includes(root)) {
      await this.preferences.set(GEARBOX_SOURCE_ROOTS, [...configured, root], PreferenceScope.User);
    }
    await this.catalogue.load();
  }

  protected async clone(repository: string): Promise<string | undefined> {
    const parent = await this.pickFolder("Clone into: the checkout becomes a new folder inside this one");
    if (parent === undefined) return undefined;
    const progress = await this.messages.showProgress({ text: `Cloning ${repository}…` });
    try {
      return await this.service.cloneSourceRepository(repository, parent);
    } catch (error) {
      void this.messages.error(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      progress.cancel();
    }
  }

  protected async pickFolder(title: string): Promise<string | undefined> {
    const uri = await this.fileDialog.showOpenDialog({
      title,
      openLabel: "Select Folder",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    return uri === undefined ? undefined : uri.path.fsPath();
  }
}
