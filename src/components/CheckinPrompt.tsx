import { t } from "../lib/i18n";
import { MOODS, type Mood } from "../lib/checkin";
import DialogBox from "./ui/DialogBox";
import { IconButton } from "./ui/controls";

type Props = {
  onPick: (mood: Mood) => void;
  onDismiss: () => void;
};

/** The row of mood buttons shown when a body check-in is due. */
export default function CheckinPrompt({ onPick, onDismiss }: Props) {
  return (
    <DialogBox
      size="sm"
      corner={
        <IconButton label={t("checkin.notNow")} onClick={onDismiss} className="icon-btn--xs">
          <i className="ti ti-x" aria-hidden="true" />
        </IconButton>
      }
      actions={
        <div className="moods" role="group" aria-label={t("checkin.question")}>
          {MOODS.map((m) => (
            <button key={m.key} type="button" onClick={() => onPick(m)} className="mood">
              <i className={`ti ${m.icon}`} aria-hidden="true" />
              {t(m.labelKey)}
            </button>
          ))}
        </div>
      }
    >
      {/* The question lives here rather than in the bubble, so the buttons are
          never left stranded when the bubble text reverts. */}
      <p>{t("checkin.question")}</p>
    </DialogBox>
  );
}
