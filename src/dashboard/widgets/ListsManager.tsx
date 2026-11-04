import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { t } from "../../lib/i18n";
import {
  createList,
  deleteList,
  getLists,
  LIST_COLORS,
  MAX_LISTS,
  recolorList,
  renameList,
  type ListColor,
  type TodoList,
} from "../../lib/todoRepo";
import { ChunkyButton, IconButton } from "../../components/ui/controls";
import { LIST_COLOR_LABEL } from "../todos/format";

function ColorPick({ value, onPick, label }: { value: ListColor; onPick: (c: ListColor) => void; label: string }) {
  return (
    <span className="color-pick" role="radiogroup" aria-label={label}>
      {LIST_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={t(LIST_COLOR_LABEL[c])}
          title={t(LIST_COLOR_LABEL[c])}
          className={`color-pick__dot list-${c}${value === c ? " color-pick__dot--on" : ""}`}
          onClick={() => onPick(c)}
        />
      ))}
    </span>
  );
}

/**
 * Settings → Lists. A small fixed set: the default list plus a few. Deleting
 * a list moves its todos to the default one.
 */
export function ListsManager() {
  const [lists, setLists] = useState<TodoList[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState<ListColor>("sky");
  const [confirm, setConfirm] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getLists().then(setLists).catch(console.error);
  }, []);
  useEffect(() => {
    load();
    const unlisten = listen("todos:changed", load);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [load]);

  const add = async () => {
    setError(null);
    const id = await createList(name, color);
    if (!id) return setError(t(lists.length >= MAX_LISTS ? "lists.full" : "lists.taken"));
    setName("");
    load();
  };

  return (
    <div className="settings">
      <p className="muted">{t("lists.hint", { n: MAX_LISTS })}</p>
      <ul className="lists">
        {lists.map((l) => (
          <li key={l.id} className="lists__row">
            <span className={`list-dot list-dot--lg list-${l.color}`} aria-hidden="true" />
            <label htmlFor={`list-${l.id}`} className="sr-only">
              {t("lists.name")}
            </label>
            <input
              id={`list-${l.id}`}
              className="field field--short lists__name"
              defaultValue={l.name}
              maxLength={40}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v === l.name) return;
                void renameList(l.id, v).then((ok) => {
                  if (!ok) {
                    e.target.value = l.name;
                    setError(t("lists.taken"));
                  } else setError(null);
                  load();
                });
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <ColorPick value={l.color} label={t("lists.colorOf", { name: l.name })} onPick={(c) => void recolorList(l.id, c).then(load)} />
            {l.is_default ? (
              <span className="lists__default">{t("lists.default")}</span>
            ) : confirm === l.id ? (
              <span className="lists__confirm">
                <ChunkyButton size="sm" variant="danger" onClick={() => void deleteList(l.id).then(() => (setConfirm(null), load()))}>
                  {t("lists.deleteYes")}
                </ChunkyButton>
                <ChunkyButton size="sm" variant="secondary" onClick={() => setConfirm(null)}>
                  {t("todo.cancel")}
                </ChunkyButton>
              </span>
            ) : (
              <IconButton label={t("lists.delete", { name: l.name })} className="icon-btn--danger" onClick={() => setConfirm(l.id)}>
                <i className="ti ti-trash" aria-hidden="true" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {confirm !== null && <p className="muted">{t("lists.deleteNote")}</p>}
      {lists.length < MAX_LISTS && (
        <form
          className="lists__add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label htmlFor="list-new" className="sr-only">
            {t("lists.new")}
          </label>
          <input
            id="list-new"
            className="field field--short"
            placeholder={t("lists.new")}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <ColorPick value={color} label={t("lists.newColor")} onPick={setColor} />
          <ChunkyButton type="submit" size="sm" disabled={!name.trim()}>
            {t("lists.add")}
          </ChunkyButton>
        </form>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
