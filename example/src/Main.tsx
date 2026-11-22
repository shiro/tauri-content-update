import { css } from "@style-this/core";
import { styled } from "@style-this/solid";
import { isTauri } from "@tauri-apps/api/core";
import { createResource, createSignal, onMount, Show } from "solid-js";
import { getPoem } from "~/api/poem";
import { appInfo, type AppInfo } from "~/native.gen";
import { color } from "~/theme";

export default function Main() {
  let count = $signal(0);
  const [info, setInfo] = createSignal<AppInfo>();
  // a command of the app, through the generated bindings
  onMount(() => isTauri() && void appInfo().then(setInfo));
  // a server function, runs on the backend
  const [poem] = createResource(() => getPoem());
  return (
    <main class={MainStyle}>
      <Title class="text-2xl font-bold">hello world</Title>
      <Button class="rounded border px-3 py-1" onClick={() => count++}>
        count: {count}
      </Button>
      <Show when={info()}>
        {(info) => (
          <Native>
            native {info().version} ({info().platform})
          </Native>
        )}
      </Show>
      <Show
        when={!poem.error}
        fallback={<Poem data-testid="poem">backend unreachable</Poem>}
      >
        <Show when={poem()}>
          {(poem) => <Poem data-testid="poem">{poem()}</Poem>}
        </Show>
      </Show>
    </main>
  );
}

const MainStyle = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
`;

const Title = styled.h1`
  color: ${color.mauve};
`;

const Native = styled.p`
  color: ${color.subtext0};
`;

const Poem = styled.p`
  max-width: 40ch;
  color: ${color.subtext1};
  font-style: italic;
`;

const Button = styled.button`
  border-color: ${color.surface2};
  background-color: ${color.surface0};
  color: ${color.text};

  &:hover {
    background-color: ${color.surface1};
  }

  &:active {
    border-color: ${color.lavender};
  }
`;
