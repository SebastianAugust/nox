import { t } from "../lib/i18n";
import DialogBox from "./ui/DialogBox";
import { IconButton } from "./ui/controls";

type BubbleProps = {
  text: string;
  isStreaming?: boolean;
  onStop?: () => void;
  /** Buttons for messages that offer a next step (reminders). */
  actions?: React.ReactNode;
};

export default function Bubble({ text, isStreaming, onStop, actions }: BubbleProps) {
  return (
    <DialogBox
      size="sm"
      role="status"
      actions={actions}
      corner={
        isStreaming && (
          <IconButton label={t("pet.stop")} onClick={onStop} className="icon-btn--xs">
            <i className="ti ti-player-stop-filled" aria-hidden="true" />
          </IconButton>
        )
      }
    >
      {/* Grows with content and scrolls past a few lines. */}
      <p className={`bubble-text${isStreaming ? " bubble-text--streaming" : ""}`}>{text}</p>
    </DialogBox>
  );
}
