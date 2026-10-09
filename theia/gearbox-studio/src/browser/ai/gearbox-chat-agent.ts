// The agent the chat has been missing.
//
// **Until this existed, the chat could not answer at all.** `@theia/ai-chat`
// registers no user-facing agent -- Theia's `Universal` and `Coder` live in
// `@theia/ai-ide`, which this application deliberately does not install (it
// drags `puppeteer-core` and the AI terminal surface ADR-0011 withdrew). Nothing
// else bound a `ChatAgent`, so every request reached `ChatService` and came back
// as "No agent was found to handle this request".
//
// That is also why `gearbox_toggle_gear` had never run: a tool is offered to the
// model only if an agent names it in `functions`, and there was no agent to name
// it.
//
// **`AbstractStreamParsingChatAgent` rather than a text-parsing base**, because
// the answers here are prose with tool calls threaded through them, not a
// structured document to be parsed back out.

import { inject, injectable } from "@theia/core/shared/inversify";
import { AbstractStreamParsingChatAgent, ChatAgentLocation } from "@theia/ai-chat";
import { MarkdownChatResponseContentImpl } from "@theia/ai-chat/lib/common/chat-model";
import type { MutableChatRequestModel } from "@theia/ai-chat/lib/common/chat-model";
import { FrontendLanguageModelRegistry } from "@theia/ai-core";
import type { LanguageModelRequirement } from "@theia/ai-core";

import { ProductGearTool } from "./product-tools";
import { GEARBOX_TOOLS } from "./gearbox-tools";
import { GEARBOX_VARIABLES } from "./gearbox-context";
import { GEARBOX_SYSTEM_PROMPT } from "./gearbox-prompt";

@injectable()
export class GearboxChatAgent extends AbstractStreamParsingChatAgent {
  /**
   * The agent's id, as a constant because three bindings name it: the agent
   * itself, and the default and fallback ids the chat resolves a request
   * through when the operator names no agent.
   */
  static readonly ID = "Gearbox";

  readonly id = GearboxChatAgent.ID;
  readonly name = GearboxChatAgent.ID;

  override readonly description =
    "Answers about the open Gearbox product from the resolver's own output: the " +
    "selection, the resolved topology, and the diagnostics. Previews changes; never " +
    "writes without asking.";

  override readonly iconClass = "codicon codicon-circuit-board";

  override readonly locations = [ChatAgentLocation.Panel];

  override readonly tags = ["Gearbox"];

  readonly languageModelRequirements: LanguageModelRequirement[] = [
    {
      purpose: "chat",
      identifier: "default/universal",
    },
  ];

  protected readonly defaultLanguageModelPurpose = "chat";

  /**
   * The tools this agent may call.
   *
   * Named explicitly rather than "everything registered": a tool that appears in
   * the model's list without anybody deciding it should is how a chat acquires a
   * capability nobody reviewed.
   */
  override readonly functions = [
    ...GEARBOX_TOOLS.map((tool) => tool.ID),
    ProductGearTool.ID,
  ];

  override readonly variables = GEARBOX_VARIABLES.map((variable) => variable.name);

  override readonly prompts = [GEARBOX_SYSTEM_PROMPT];

  protected override systemPromptId: string | undefined = GEARBOX_SYSTEM_PROMPT.id;

  // The *frontend* registry, which is the one that resolves an alias like
  // `default/universal` to a concrete model and knows whether it is ready.
  // `LanguageModelRegistry` alone has neither.
  @inject(FrontendLanguageModelRegistry)
  protected readonly models!: FrontendLanguageModelRegistry;

  /**
   * Refuse in Gearbox's words when there is no model, rather than in Theia's.
   *
   * Without this the answer is *"Couldn't find a ready language model for agent
   * Gearbox. Please check your setup!"* -- true, and useless to an integrator who
   * has no reason to know that a language model is configured by an API key, let
   * alone where. It names neither the key nor the place to put it, and it arrives
   * as an error balloon, which is the shape reserved for things that went wrong
   * rather than things that were never set up.
   *
   * Checked before the request rather than caught after it: the throw happens
   * inside `getLanguageModelForRequest`, several frames down, and by then the
   * only thing left to do is replace one error with another.
   */
  override async invoke(request: MutableChatRequestModel): Promise<void> {
    const selector = this.getLanguageModelSelector(this.defaultLanguageModelPurpose);
    const identifier = selector?.identifier;
    if (identifier !== undefined) {
      const ready = await this.models.getReadyLanguageModel(identifier);
      if (ready === undefined) {
        request.response.response.addContent(
          new MarkdownChatResponseContentImpl(
            // Constructor Studio: the model is Studio's (`studio-llm`), on the
            // person's own key, configured when the portal hands this IDE its
            // token. There is no key to type here, and asking for one would be
            // the wrong fix: it belongs in the person's Studio profile.
            `I have no language model to answer with, so nothing I said would be grounded.\n\n` +
              `The model comes from Constructor Studio and is set up when the IDE is opened ` +
              `from the portal, on your own Anthropic or OpenAI key. If this persists, add a ` +
              `key to your Studio profile, or connect one (for yourself or this workspace) ` +
              `under Connections. Resolving, generating and every diagnostic work without it.`,
          ),
        );
        // Complete rather than error: nothing failed, something is unset, and the
        // two deserve different shapes on screen.
        request.response.complete();
        return;
      }
    }
    return super.invoke(request);
  }

  // Constructor Studio: Gearbox Studio replaced a bare `Connection error.` with
  // a probe of Anthropic's endpoint from its backend. Here the model is reached
  // through the session gate at `studio-llm`, which that probe does not know,
  // so a transport failure is reported as Theia reports it.
}
