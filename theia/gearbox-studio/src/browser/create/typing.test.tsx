/**
 * @jest-environment jsdom
 */
// A controlled input inside a Theia ReactWidget keeps what is typed only when
// the widget repaints inside the change event -- React restores the input to
// its last committed value right after the handler, so a repaint posted for
// later loses every keystroke that lands before it.
import "reflect-metadata";

(globalThis as { DragEvent?: unknown }).DragEvent ??= class DragEvent {};

import { Widget } from "@theia/core/shared/@lumino/widgets";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import React from "@theia/core/shared/react";

import { repaintNow } from "../widgets/repaint";

class Form extends ReactWidget {
  value = "new-product";
  constructor(protected readonly repaint: (w: ReactWidget) => void) {
    super();
    // No perfect-scrollbar under jsdom.
    this.scrollOptions = undefined;
  }
  protected render(): React.ReactNode {
    return (
      <input
        data-id
        value={this.value}
        onChange={(e) => {
          this.value = e.target.value;
          this.repaint(this);
        }}
      />
    );
  }
}

/** What a key press does to an input: the browser edits the value, then fires `input`. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mount(repaint: (w: ReactWidget) => void): Promise<{ form: Form; input: HTMLInputElement }> {
  const form = new Form(repaint);
  Widget.attach(form, document.body);
  repaintNow(form);
  // The first render is not inside an event, so React schedules it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const input = form.node.querySelector<HTMLInputElement>("[data-id]");
  if (input === null) throw new Error("the input did not render");
  return { form, input };
}

describe("typing into a wizard field", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps every keystroke when the widget repaints inside the event", async () => {
    const { form, input } = await mount(repaintNow);
    type(input, "s");
    type(input, "sh");
    type(input, "sho");
    type(input, "shop");
    expect(form.value).toBe("shop");
    expect(input.value).toBe("shop");
  });

  it("loses them when the repaint is only posted, which is what the wizard did", async () => {
    const { form, input } = await mount((w) => w.update());
    type(input, "s");
    // The posted repaint has not run: React put the old value back.
    expect(input.value).toBe("new-product");
    type(input, `${input.value}h`);
    expect(form.value).toBe("new-producth");
  });
});
