/**
 * @jest-environment jsdom
 */
// The Composition tree: one plugin can be removed from beside it, without
// taking its host and the host's other plugins along. The host is expanded:
// a host's plugins start folded (Gearbox Studio's composition list).
import "reflect-metadata";

jest.mock("../reveal-link", () => ({ RevealLink: () => null }));

import React from "@theia/core/shared/react";

import type { ProductState } from "../product-store";
import type { RevealService } from "../reveal-service";
import { Composition } from "./composition";

interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

const state = {
  open: { path: "/w/product.gdl", label: "product.gdl" },
  profile: "local",
  intent: {
    selected_gears: [
      {
        gear: "authn-resolver",
        plugins: [
          { gear: "oidc-authn-plugin", entry_index: 0 },
          { gear: "static-authn-plugin", entry_index: 1 },
        ],
      },
    ],
  },
} as unknown as ProductState;

describe("the Composition tree", () => {
  let host: HTMLDivElement;
  let root: Root;
  const remove = jest.fn();

  beforeEach(async () => {
    remove.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(
        <Composition
          state={state}
          descriptors={[]}
          selection={undefined}
          select={() => undefined}
          add={() => undefined}
          remove={remove}
          settings={null}
          reveals={{} as RevealService}
          expanded={new Set(["authn-resolver"])}
          create={() => undefined}
          toggleFold={() => undefined}
        />,
      ),
    );
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  it("removes one plugin from beside it, and only that entry", async () => {
    const button = host.querySelector<HTMLButtonElement>('[data-remove-plugin="authn-resolver:0"]');
    expect(button?.getAttribute("aria-label")).toBe("Remove oidc-authn-plugin from authn-resolver");
    await act(() => button?.click());
    expect(remove).toHaveBeenCalledWith("authn-resolver", 0);
  });

  it("says on the host's Remove that it takes the plugins too", () => {
    const hostRemove = host.querySelector<HTMLButtonElement>('[aria-label="Remove authn-resolver from product"]');
    expect(hostRemove?.title).toMatch(/and its plugins \(oidc-authn-plugin, static-authn-plugin\)/);
  });
});
