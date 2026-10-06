// `product.lock` opens read-only.
//
// `cpt-gearbox-fr-lock-read-only`: "The system MUST present `product.lock` as
// read-only in the editor, in addition to the generated header it already
// carries." ADR `cpt-gearbox-adr-authoring-ownership-tiers` puts it at tier 1
// and says why a header is not enough: "A header comment asks; a read-only
// editor tells. An edit to the lock is silently discarded by the next resolve,
// which is the failure mode worth preventing rather than detecting."
//
// **Why a rebind, and why this one.** Theia offers three places to make
// something read-only and two of them do not fit:
//
//   - `FileService.getReadOnlyMessage` is resolved *per scheme*, so it can only
//     make every `file://` resource read-only. Useless for one filename.
//   - a `ResourceResolver` returning a `Resource` without `saveContents` is the
//     model-level answer, but claiming `file://` URIs means reimplementing
//     `FileResource` -- watching, encoding, backups -- to change one flag.
//   - `MonacoEditorProvider.createMonacoEditorOptions` is a documented protected
//     hook, and the option it sets is exactly the one the requirement names: the
//     editor is read-only, and Monaco says so when a key is pressed.
//
// The model stays writable, so a programmatic edit could still save. That is the
// accepted limit: the requirement is about a person editing a file that looks
// editable, and the generated header covers the rest.

import { injectable } from "@theia/core/shared/inversify";
import { MonacoEditor } from "@theia/monaco/lib/browser/monaco-editor";
import { MonacoEditorModel } from "@theia/monaco/lib/browser/monaco-editor-model";
import { MonacoEditorProvider } from "@theia/monaco/lib/browser/monaco-editor-provider";

/**
 * Which files the tool owns entirely.
 *
 * By filename rather than by directory: `generate` writes the lock under
 * `.gearbox/<product>/<profile>/`, and encoding that layout here would be a
 * second place it is written down. The name is the stable fact -- `gearbox lock`
 * defaults to `product.lock` too.
 */
function isToolOwned(uri: string): boolean {
  return uri.endsWith("/product.lock");
}

@injectable()
export class ReadOnlyLockEditorProvider extends MonacoEditorProvider {
  protected override createMonacoEditorOptions(model: MonacoEditorModel): MonacoEditor.IOptions {
    const options = super.createMonacoEditorOptions(model);
    if (!isToolOwned(model.uri)) {
      return options;
    }
    return {
      ...options,
      readOnly: true,
      // Monaco shows this the moment someone types, which is the point: the
      // refusal has to explain itself or it reads as a broken editor.
      readOnlyMessage: {
        value:
          "`product.lock` is generated. Edit `product.gdl` and resolve again — " +
          "an edit here is discarded by the next resolve.",
        isTrusted: false,
      },
    };
  }
}
