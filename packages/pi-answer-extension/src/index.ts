/**
 * Answer Extension — Q&A extraction hook
 *
 * Based on https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/answer.ts
 *
 * Extracts questions from assistant responses and presents an interactive TUI
 * for answering them.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { type Api, complete, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedQuestion {
  question: string;
  context?: string;
}

interface ExtractionResult {
  questions: ExtractedQuestion[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

const CODEX_MODEL_ID = "gpt-5.1-codex-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * Prefer Codex mini for extraction when available, otherwise fallback to haiku
 * or the current model.
 */
async function selectExtractionModel(
  currentModel: Model<Api>,
  modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
  const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
  if (codexModel) {
    const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);
    if (auth.ok) {
      return codexModel;
    }
  }

  const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
  if (!haikuModel) {
    return currentModel;
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
  if (!auth.ok) {
    return currentModel;
  }

  return haikuModel;
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/** Parse the JSON response from the LLM, handling optional markdown fences. */
function parseExtractionResult(text: string): ExtractionResult | null {
  try {
    let jsonStr = text;

    // Remove markdown code block if present
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);
    if (parsed && Array.isArray(parsed.questions)) {
      return parsed as ExtractionResult;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interactive Q&A TUI component
// ---------------------------------------------------------------------------

class QnAComponent implements Component {
  private questions: ExtractedQuestion[];
  private answers: string[];
  private currentIndex = 0;
  private editor: Editor;
  private tui: TUI;
  private onDone: (result: string | null) => void;
  private showingConfirmation = false;

  // Render cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  // ANSI helpers
  private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

  constructor(questions: ExtractedQuestion[], tui: TUI, onDone: (result: string | null) => void) {
    this.questions = questions;
    this.answers = questions.map(() => "");
    this.tui = tui;
    this.onDone = onDone;

    const editorTheme: EditorTheme = {
      borderColor: this.dim,
      selectList: {
        selectedPrefix: this.cyan,
        selectedText: this.cyan,
        description: this.gray,
        scrollInfo: this.dim,
        noMatch: this.dim,
      },
    };

    this.editor = new Editor(tui, editorTheme);
    // Disable the editor's built-in submit so we can handle Enter ourselves
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      this.invalidate();
      this.tui.requestRender();
    };
  }

  // ------ internal helpers ------

  private saveCurrentAnswer(): void {
    this.answers[this.currentIndex] = this.editor.getText();
  }

  private navigateTo(index: number): void {
    if (index < 0 || index >= this.questions.length) return;
    this.saveCurrentAnswer();
    this.currentIndex = index;
    this.editor.setText(this.answers[index] || "");
    this.invalidate();
  }

  private submit(): void {
    this.saveCurrentAnswer();

    const parts: string[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const a = this.answers[i]?.trim() || "(no answer)";
      parts.push(`Q: ${q.question}`);
      if (q.context) {
        parts.push(`> ${q.context}`);
      }
      parts.push(`A: ${a}`);
      parts.push("");
    }

    this.onDone(parts.join("\n").trim());
  }

  private cancel(): void {
    this.onDone(null);
  }

  // ------ Component interface ------

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    // Confirmation dialog
    if (this.showingConfirmation) {
      if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
        this.submit();
        return;
      }
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        data.toLowerCase() === "n"
      ) {
        this.showingConfirmation = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return;
    }

    // Global escape / cancel
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
      return;
    }

    // Tab / Shift+Tab navigation
    if (matchesKey(data, Key.tab)) {
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      if (this.currentIndex > 0) {
        this.navigateTo(this.currentIndex - 1);
        this.tui.requestRender();
      }
      return;
    }

    // Arrow keys when editor is empty
    if (matchesKey(data, Key.up) && this.editor.getText() === "") {
      if (this.currentIndex > 0) {
        this.navigateTo(this.currentIndex - 1);
        this.tui.requestRender();
        return;
      }
    }
    if (matchesKey(data, Key.down) && this.editor.getText() === "") {
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
        this.tui.requestRender();
        return;
      }
    }

    // Plain Enter → next question or confirm on last
    if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
      this.saveCurrentAnswer();
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
      } else {
        this.showingConfirmation = true;
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Everything else goes to the editor
    this.editor.handleInput(data);
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const boxWidth = Math.min(width - 4, 120);
    const contentWidth = boxWidth - 4; // 2 chars padding each side

    const horizontalLine = (count: number) => "─".repeat(count);

    const boxLine = (content: string, leftPad = 2): string => {
      const paddedContent = " ".repeat(leftPad) + content;
      const contentLen = visibleWidth(paddedContent);
      const rightPad = Math.max(0, boxWidth - contentLen - 2);
      return `${this.dim("│")}${paddedContent}${" ".repeat(rightPad)}${this.dim("│")}`;
    };

    const emptyBoxLine = (): string =>
      `${this.dim("│")}${" ".repeat(boxWidth - 2)}${this.dim("│")}`;

    const padToWidth = (line: string): string => {
      const len = visibleWidth(line);
      return line + " ".repeat(Math.max(0, width - len));
    };

    // Title
    lines.push(padToWidth(this.dim(`╭${horizontalLine(boxWidth - 2)}╮`)));
    const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
    lines.push(padToWidth(boxLine(title)));
    lines.push(padToWidth(this.dim(`├${horizontalLine(boxWidth - 2)}┤`)));

    // Progress dots
    const progressParts: string[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const answered = (this.answers[i]?.trim() || "").length > 0;
      const current = i === this.currentIndex;
      if (current) {
        progressParts.push(this.cyan("●"));
      } else if (answered) {
        progressParts.push(this.green("●"));
      } else {
        progressParts.push(this.dim("○"));
      }
    }
    lines.push(padToWidth(boxLine(progressParts.join(" "))));
    lines.push(padToWidth(emptyBoxLine()));

    // Current question
    const q = this.questions[this.currentIndex];
    const questionText = `${this.bold("Q:")} ${q.question}`;
    for (const line of wrapTextWithAnsi(questionText, contentWidth)) {
      lines.push(padToWidth(boxLine(line)));
    }

    // Context (optional)
    if (q.context) {
      lines.push(padToWidth(emptyBoxLine()));
      const contextText = this.gray(`> ${q.context}`);
      for (const line of wrapTextWithAnsi(contextText, contentWidth - 2)) {
        lines.push(padToWidth(boxLine(line)));
      }
    }

    lines.push(padToWidth(emptyBoxLine()));

    // Editor (answer input)
    const answerPrefix = this.bold("A: ");
    const editorWidth = contentWidth - 4 - 3; // padding + "A: "
    const editorLines = this.editor.render(editorWidth);
    for (let i = 1; i < editorLines.length - 1; i++) {
      if (i === 1) {
        lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
      } else {
        lines.push(padToWidth(boxLine(`   ${editorLines[i]}`)));
      }
    }

    lines.push(padToWidth(emptyBoxLine()));

    // Footer
    if (this.showingConfirmation) {
      lines.push(padToWidth(this.dim(`├${horizontalLine(boxWidth - 2)}┤`)));
      const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
      lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
    } else {
      lines.push(padToWidth(this.dim(`├${horizontalLine(boxWidth - 2)}┤`)));
      const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
      lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
    }
    lines.push(padToWidth(this.dim(`╰${horizontalLine(boxWidth - 2)}╯`)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

async function answerHandler(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("answer requires interactive mode", "error");
    return;
  }

  if (!ctx.model) {
    ctx.ui.notify("No model selected", "error");
    return;
  }

  // Find the last assistant message on the current branch
  const branch = ctx.sessionManager.getBranch();
  let lastAssistantText: string | undefined;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message") {
      const msg = entry.message;
      if ("role" in msg && msg.role === "assistant") {
        if (msg.stopReason !== "stop") {
          ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
          return;
        }
        const textParts = msg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text);
        if (textParts.length > 0) {
          lastAssistantText = textParts.join("\n");
          break;
        }
      }
    }
  }

  if (!lastAssistantText) {
    ctx.ui.notify("No assistant messages found", "error");
    return;
  }

  // Select the best model for extraction
  const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

  // Run extraction with loader UI
  const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(
      tui,
      theme,
      `Extracting questions using ${extractionModel.id}...`,
    );
    loader.onAbort = () => done(null);

    const doExtract = async () => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: lastAssistantText! }],
        timestamp: Date.now(),
      };

      const response = await complete(
        extractionModel,
        { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
      );

      if (response.stopReason === "aborted") {
        return null;
      }

      const responseText = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      return parseExtractionResult(responseText);
    };

    doExtract()
      .then(done)
      .catch(() => done(null));

    return loader;
  });

  if (extractionResult === null) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  if (extractionResult.questions.length === 0) {
    ctx.ui.notify("No questions found in the last message", "info");
    return;
  }

  // Show the interactive Q&A component
  const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
    return new QnAComponent(extractionResult.questions, tui, done);
  });

  if (answersResult === null) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  // Send the answers and trigger a turn
  pi.sendMessage(
    {
      customType: "answers",
      content: `I answered your questions in the following way:\n\n${answersResult}`,
      display: true,
    },
    { triggerTurn: true },
  );
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("answer", {
    description: "Extract questions from last assistant message into interactive Q&A",
    handler: (_args, ctx) => answerHandler(pi, ctx),
  });

  pi.registerShortcut("ctrl+.", {
    description: "Extract and answer questions",
    handler: (ctx) => answerHandler(pi, ctx),
  });
}
