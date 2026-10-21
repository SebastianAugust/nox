import toothless from "../assets/toothless.png";

export type PetState =
  | "idle"
  | "thinking"
  | "happy"
  | "sleeping"
  | "excited"
  | "alert";

type PetProps = {
  onClick?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  state?: PetState;
};

// Eye positions in the 96px display space, detected from toothless.png's green
// eye pixels. Eyelids are sized to fully cover each eye (they blend with the
// dark face, so a little extra coverage is invisible).
const EYE_TOP = 31.2;
const EYE_W = 8;
const EYE_H = 12;
const LEFT_EYE_LEFT = 27.9;
const RIGHT_EYE_LEFT = 57.1;

// The eyes are baked into the sprite, so every expression is made by how the
// eyelid covers them: a full cover is a blink, a half cover from below is a
// happy squint, no cover at all is wide-awake.
const LID_CLASS: Record<PetState, string> = {
  idle: "pet-blink",
  thinking: "pet-think",
  happy: "pet-happy",
  sleeping: "pet-sleep",
  excited: "pet-excited",
  alert: "pet-alert",
};

const BODY_CLASS: Record<PetState, string> = {
  idle: "",
  thinking: "",
  happy: "",
  sleeping: "pet-body-breathe",
  excited: "pet-body-bounce",
  alert: "pet-body-alert",
};

export default function Pet({ onClick, onMouseDown, state = "idle" }: PetProps) {
  const lidClass = `pet-eyelid ${LID_CLASS[state]}`;

  return (
    <div
      onClick={onClick}
      onMouseDown={onMouseDown}
      title="Click to chat with Nox"
      className={`pet-body ${BODY_CLASS[state]}`}
      style={{
        position: "relative",
        width: 96,
        height: 96,
        cursor: "pointer",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      <img
        src={toothless}
        alt="Nox"
        draggable={false}
        style={{
          width: 96,
          height: 96,
          display: "block",
          imageRendering: "pixelated",
        }}
      />
      <span
        className={lidClass}
        style={{ left: LEFT_EYE_LEFT, top: EYE_TOP, width: EYE_W, height: EYE_H }}
      />
      <span
        className={lidClass}
        style={{
          left: RIGHT_EYE_LEFT,
          top: EYE_TOP,
          width: EYE_W,
          height: EYE_H,
          animationDelay: "0.1s", // slight offset so eyes don't blink in lockstep
        }}
      />
      {state === "sleeping" && <span className="pet-zzz">z</span>}
    </div>
  );
}
