// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppShortcut } from "@bb/domain";
import {
  AppCommandProvider,
  useAppCommandContext,
  useAppCommandHandler,
  useIsAppCommandModifierHeld,
} from "@/components/commands/AppCommandProvider";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  PromptBoxInternal,
} from "./PromptBoxInternal";
import {
  PaneContext,
  type PaneContextValue,
} from "@/views/thread-detail/PaneContext";

const testState = vi.hoisted(() => ({
  calls: [] as string[],
  composerInputLocked: false,
  sidebarHandlerResult: true,
  voiceCalls: [] as string[],
  // The sidebar chord under test. Overridden per test to cover both a chord the
  // editor ignores and a chord the editor's own keymap claims.
  sidebarShortcut: {
    key: "\\",
    mod: true,
    meta: false,
    control: false,
    alt: false,
    shift: false,
  } as AppShortcut,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { ...defaultAppSettings },
      keybindings: [
        {
          command: "sidebar.toggle" as const,
          desktopOnly: false,
          shortcut: testState.sidebarShortcut,
          when: { all: ["mainSurface" as const], none: ["modalOpen" as const] },
        },
        {
          command: "voice.toggle" as const,
          desktopOnly: false,
          shortcut: {
            key: "r",
            mod: false,
            meta: false,
            control: false,
            alt: true,
            shift: false,
          },
          when: {
            all: ["mainSurface" as const, "promptAvailable" as const],
            none: ["modalOpen" as const],
          },
        },
      ],
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

vi.mock("@/lib/plugin-sdk-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugin-sdk-hooks")>()),
  useComposerInputLock: () => testState.composerInputLocked,
}));

function SidebarToggleHandler() {
  useAppCommandHandler("sidebar.toggle", () => {
    testState.calls.push("sidebar.toggle");
    return testState.sidebarHandlerResult;
  });
  return null;
}

function ShortcutHintState() {
  return (
    <span>{useIsAppCommandModifierHeld() ? "hint-held" : "hint-released"}</span>
  );
}

function PromptAvailableContext() {
  useAppCommandContext("promptAvailable", true);
  return null;
}

function renderComposer(
  extra: React.ReactNode = null,
  voice: React.ComponentProps<typeof PromptBoxInternal>["voice"] = undefined,
  submission?: React.ComponentProps<typeof PromptBoxInternal>["submission"],
) {
  render(
    <MemoryRouter>
      <AppCommandProvider>
        <SidebarToggleHandler />
        <PromptAvailableContext />
        {extra}
        <PromptBoxInternal
          value=""
          mentionRanges={[]}
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          submission={submission}
          voice={voice}
          mentionMenuPlacement="bottom"
          typeahead={{
            mention: {
              suggestions: [],
              isLoading: false,
              isError: false,
              onQueryChange: vi.fn(),
            },
            command: INERT_TYPEAHEAD_COMMAND_CONFIG,
          }}
        />
      </AppCommandProvider>
    </MemoryRouter>,
  );
  const editor = document.querySelector<HTMLElement>(
    "[data-promptbox-editor-content] [contenteditable]",
  );
  if (editor === null) throw new Error("prompt editor did not render");
  editor.focus();
  return editor;
}

function renderSplitVoiceComposers(
  focusedVoice: NonNullable<
    React.ComponentProps<typeof PromptBoxInternal>["voice"]
  >,
  unfocusedVoice: NonNullable<
    React.ComponentProps<typeof PromptBoxInternal>["voice"]
  >,
): void {
  render(
    <MemoryRouter>
      <AppCommandProvider>
        <PromptAvailableContext />
        <PaneContext.Provider value={testPaneContext("focused", true)}>
          <div data-split-pane-id="focused">
            <div data-app-composer="" data-app-composer-role="primary">
              <PromptBoxInternal
                value=""
                mentionRanges={[]}
                onChange={vi.fn()}
                onSubmit={vi.fn()}
                voice={focusedVoice}
                mentionMenuPlacement="bottom"
                typeahead={{
                  mention: {
                    suggestions: [],
                    isLoading: false,
                    isError: false,
                    onQueryChange: vi.fn(),
                  },
                  command: INERT_TYPEAHEAD_COMMAND_CONFIG,
                }}
              />
            </div>
          </div>
        </PaneContext.Provider>
        <PaneContext.Provider value={testPaneContext("unfocused", false)}>
          <div data-split-pane-id="unfocused">
            <div data-app-composer="" data-app-composer-role="primary">
              <PromptBoxInternal
                value=""
                mentionRanges={[]}
                onChange={vi.fn()}
                onSubmit={vi.fn()}
                voice={unfocusedVoice}
                mentionMenuPlacement="bottom"
                typeahead={{
                  mention: {
                    suggestions: [],
                    isLoading: false,
                    isError: false,
                    onQueryChange: vi.fn(),
                  },
                  command: INERT_TYPEAHEAD_COMMAND_CONFIG,
                }}
              />
            </div>
          </div>
        </PaneContext.Provider>
      </AppCommandProvider>
    </MemoryRouter>,
  );
}

function pressInEditor(
  editor: HTMLElement,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  editor.dispatchEvent(event);
  return event;
}

function pressOnBody(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.body.dispatchEvent(event);
  return event;
}

function testPaneContext(paneId: string, isFocused: boolean): PaneContextValue {
  return {
    paneId,
    isFocused,
    isSplitPane: true,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: false,
    onRequestClose: null,
    isMaximized: false,
    onToggleMaximize: null,
    isBoundedPane: true,
    isTopRow: false,
    ownsWindowTopLeft: false,
    navigateInPane: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  testState.calls.length = 0;
  testState.voiceCalls.length = 0;
  testState.composerInputLocked = false;
  testState.sidebarHandlerResult = true;
  testState.sidebarShortcut = {
    key: "\\",
    mod: true,
    meta: false,
    control: false,
    alt: false,
    shift: false,
  };
});

describe("prompt editor app shortcuts", () => {
  it("runs the sidebar shortcut while the composer has focus", () => {
    const editor = renderComposer();

    const event = pressInEditor(editor, { ctrlKey: true, key: "\\" });

    expect(testState.calls).toEqual(["sidebar.toggle"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["idle", "start"],
    ["error", "start"],
    ["recording", "stop"],
    ["transcribing", "cancel"],
  ] as const)("toggles voice input from %s state", (state, expectedCall) => {
    const voice = {
      state,
      isSupported: true,
      stream: null,
      start: vi.fn(() => {
        testState.voiceCalls.push("start");
      }),
      stop: vi.fn(() => {
        testState.voiceCalls.push("stop");
      }),
      cancel: vi.fn(() => {
        testState.voiceCalls.push("cancel");
      }),
    };
    const editor = renderComposer(null, voice);

    const event = pressInEditor(editor, {
      altKey: true,
      code: "KeyR",
      key: "r",
    });

    expect(testState.voiceCalls).toEqual([expectedCall]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps voice scoped to the focused pane's primary composer", () => {
    const focusedVoice = {
      state: "recording" as const,
      isSupported: true,
      stream: null,
      start: vi.fn(),
      stop: vi.fn(() => {
        testState.voiceCalls.push("focused.stop");
      }),
      cancel: vi.fn(),
    };
    const unfocusedVoice = {
      state: "idle" as const,
      isSupported: true,
      stream: null,
      start: vi.fn(() => {
        testState.voiceCalls.push("unfocused.start");
      }),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    renderSplitVoiceComposers(focusedVoice, unfocusedVoice);
    const editors = document.querySelectorAll<HTMLElement>(
      "[data-promptbox-editor-content] [contenteditable]",
    );
    expect(editors).toHaveLength(2);

    const stalePaneEvent = pressInEditor(editors[1]!, {
      altKey: true,
      code: "KeyR",
      key: "r",
    });
    expect(unfocusedVoice.start).not.toHaveBeenCalled();
    expect(focusedVoice.stop).not.toHaveBeenCalled();
    expect(stalePaneEvent.defaultPrevented).toBe(true);

    const nonEditorEvent = pressOnBody({
      altKey: true,
      code: "KeyR",
      key: "r",
    });
    expect(focusedVoice.stop).toHaveBeenCalledOnce();
    expect(unfocusedVoice.start).not.toHaveBeenCalled();
    expect(nonEditorEvent.defaultPrevented).toBe(true);
  });

  it("lets an active focused secondary composer retain shortcut ownership", () => {
    const primaryVoice = {
      state: "idle" as const,
      isSupported: true,
      stream: null,
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    const secondaryVoice = {
      ...primaryVoice,
      state: "recording" as const,
      stop: vi.fn(() => {
        testState.voiceCalls.push("secondary.stop");
      }),
    };
    const renderPrompt = (
      role: "primary" | "secondary",
      voice: NonNullable<
        React.ComponentProps<typeof PromptBoxInternal>["voice"]
      >,
    ) => (
      <div data-app-composer="" data-app-composer-role={role}>
        <PromptBoxInternal
          value=""
          mentionRanges={[]}
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          voice={voice}
          mentionMenuPlacement="bottom"
          typeahead={{
            mention: {
              suggestions: [],
              isLoading: false,
              isError: false,
              onQueryChange: vi.fn(),
            },
            command: INERT_TYPEAHEAD_COMMAND_CONFIG,
          }}
        />
      </div>
    );
    render(
      <MemoryRouter>
        <AppCommandProvider>
          <PromptAvailableContext />
          <PaneContext.Provider value={testPaneContext("focused", true)}>
            <div data-split-pane-id="focused">
              {renderPrompt("secondary", secondaryVoice)}
              {renderPrompt("primary", primaryVoice)}
            </div>
          </PaneContext.Provider>
        </AppCommandProvider>
      </MemoryRouter>,
    );
    const secondaryEditor = document.querySelector<HTMLElement>(
      '[data-app-composer-role="secondary"] [data-promptbox-editor-content] [contenteditable]',
    );
    expect(secondaryEditor).not.toBeNull();

    const event = pressInEditor(secondaryEditor!, {
      altKey: true,
      code: "KeyR",
      key: "r",
    });

    expect(secondaryVoice.stop).toHaveBeenCalledOnce();
    expect(primaryVoice.start).not.toHaveBeenCalled();
    expect(testState.voiceCalls).toEqual(["secondary.stop"]);
    expect(event.defaultPrevented).toBe(true);

    const bodyEvent = pressOnBody({
      altKey: true,
      code: "KeyR",
      key: "r",
    });

    expect(secondaryVoice.stop).toHaveBeenCalledTimes(2);
    expect(primaryVoice.start).not.toHaveBeenCalled();
    expect(testState.voiceCalls).toEqual(["secondary.stop", "secondary.stop"]);
    expect(bodyEvent.defaultPrevented).toBe(true);
  });

  it("stops or cancels voice from a non-editor target", () => {
    const voice = {
      state: "transcribing" as const,
      isSupported: true,
      stream: null,
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(() => {
        testState.voiceCalls.push("cancel");
      }),
    };
    renderComposer(null, voice);

    const event = pressOnBody({
      altKey: true,
      code: "KeyR",
      key: "r",
    });

    expect(voice.cancel).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("consumes the voice shortcut without starting when unavailable or submitting", () => {
    const unavailableVoice = {
      state: "idle" as const,
      isSupported: false,
      stream: null,
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    const editor = renderComposer(null, unavailableVoice);
    const unavailableEvent = pressInEditor(editor, {
      altKey: true,
      code: "KeyR",
      key: "r",
    });

    expect(unavailableVoice.start).not.toHaveBeenCalled();
    expect(unavailableEvent.defaultPrevented).toBe(true);
    cleanup();

    const submittingVoice = {
      ...unavailableVoice,
      isSupported: true,
    };
    const submittingEditor = renderComposer(null, submittingVoice, {
      isSubmitting: true,
    });
    const submittingEvent = pressInEditor(submittingEditor, {
      altKey: true,
      code: "KeyR",
      key: "r",
    });

    expect(submittingVoice.start).not.toHaveBeenCalled();
    expect(submittingEvent.defaultPrevented).toBe(true);
  });

  it("stops active voice input while a submit is in progress", () => {
    const voice = {
      state: "recording" as const,
      isSupported: true,
      stream: null,
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    renderComposer(null, voice, { isSubmitting: true });

    const event = pressOnBody({
      altKey: true,
      code: "KeyR",
      key: "r",
    });

    expect(voice.stop).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("runs a sidebar shortcut whose chord the editor keymap also claims", () => {
    // Mod+Shift+B toggles a blockquote in the editor. The editor cancels the
    // event, which used to leave the app command unreachable from the composer.
    testState.sidebarShortcut = {
      key: "b",
      mod: true,
      meta: false,
      control: false,
      alt: false,
      shift: true,
    };
    const editor = renderComposer();

    pressInEditor(editor, {
      code: "KeyB",
      ctrlKey: true,
      key: "B",
      shiftKey: true,
    });

    expect(testState.calls).toEqual(["sidebar.toggle"]);
  });

  it("releases composer focus on Escape", () => {
    const editor = renderComposer();
    expect(document.activeElement).toBe(editor);

    pressInEditor(editor, { key: "Escape" });

    expect(document.activeElement).not.toBe(editor);
  });

  it("offers a declined chord to the handlers only once", () => {
    // The editor dispatches first and leaves a declined event alone, so the
    // window listener receives the same event. The handlers must not run twice.
    testState.sidebarHandlerResult = false;
    const editor = renderComposer();

    const event = pressInEditor(editor, { ctrlKey: true, key: "\\" });

    expect(testState.calls).toEqual(["sidebar.toggle"]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("clears the keyboard hint when the composer runs a shortcut", () => {
    vi.useFakeTimers();
    try {
      const editor = renderComposer(<ShortcutHintState />);
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }),
      );
      act(() => vi.advanceTimersByTime(700));
      expect(screen.getByText("hint-held")).toBeDefined();

      act(() => {
        pressInEditor(editor, { ctrlKey: true, key: "\\" });
      });

      expect(testState.calls).toEqual(["sidebar.toggle"]);
      expect(screen.getByText("hint-released")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases focus on Escape while a plugin locks the composer", () => {
    testState.composerInputLocked = true;
    const editor = renderComposer();
    expect(editor.getAttribute("contenteditable")).toBe("false");
    editor.focus();
    expect(document.activeElement).toBe(editor);

    pressInEditor(editor, { key: "Escape" });

    expect(document.activeElement).not.toBe(editor);
  });

  it("keeps typed text in the composer", () => {
    const editor = renderComposer();

    const event = pressInEditor(editor, { code: "KeyB", key: "b" });

    expect(testState.calls).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
