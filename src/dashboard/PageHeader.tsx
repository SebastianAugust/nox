import NightSky from "../components/deco/NightSky";
import type { Appearance } from "../lib/theme";

/**
 * The sky band at the top of a page. Compact on most pages; Home passes
 * `hero` for the tall version with the pet and its dialog box.
 */
export default function PageHeader({
  appearance,
  hero,
  children,
}: {
  appearance: Appearance;
  hero?: boolean;
  children: React.ReactNode;
}) {
  return (
    <header className={`page-header${hero ? " page-header--hero" : ""}`}>
      <NightSky animated={appearance.animations} lightning={appearance.lightning} compact={!hero} />
      <div className="page-header__content">{children}</div>
    </header>
  );
}
