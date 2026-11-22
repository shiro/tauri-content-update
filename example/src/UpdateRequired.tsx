import { styled } from "@style-this/solid";
import { createEffect } from "solid-js";
import { updateRequired } from "~/contentUpdate";
import { color } from "~/theme";

/** a modal that blocks the app while the published web version needs a newer app */
export default function UpdateRequired() {
  let dialog!: HTMLDialogElement;
  const show = () => {
    if (updateRequired() && !dialog.open) dialog.showModal();
  };
  createEffect(show);
  return (
    <Dialog
      ref={dialog}
      aria-labelledby="update-required-title"
      // not dismissible: Escape/back only cancel, and browsers may close it anyway after repeated
      // cancels (close watchers), so it's reopened
      onCancel={(e) => e.preventDefault()}
      onClose={show}
    >
      <Title id="update-required-title" class="text-xl font-bold">
        Update required
      </Title>
      <p>
        A new version of this app is available, but it needs a newer version of
        the app than the one installed. Please update the app from your app
        store to continue.
      </p>
    </Dialog>
  );
}

const Dialog = styled.dialog`
  max-width: min(28rem, calc(100vw - 32px));
  margin: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid ${color.surface2};
  border-radius: 8px;
  background-color: ${color.mantle};
  color: ${color.text};

  &:not([open]) {
    display: none;
  }

  &::backdrop {
    background-color: rgb(24 25 38 / 0.8);
  }
`;

const Title = styled.h2`
  color: ${color.peach};
`;
