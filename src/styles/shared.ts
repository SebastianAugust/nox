// Shared style fragments for the dashboard.

export const sectionLabel = {
  fontSize: 12,
  color: "rgba(255,255,255,0.25)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  marginBottom: 8,
};
export const card = {
  background: "rgba(255,255,255,0.03)",
  border: "0.5px solid rgba(255,255,255,0.07)",
  borderRadius: 10,
  padding: "12px 16px",
};
export const statCard = {
  background: "rgba(255,255,255,0.03)",
  border: "0.5px solid rgba(255,255,255,0.07)",
  borderRadius: 8,
  padding: 14,
};
export const rowBorder = (last: boolean) => ({
  borderBottom: last ? "none" : "0.5px solid rgba(255,255,255,0.04)",
});
export const emptyText = {
  fontSize: 12,
  color: "rgba(255,255,255,0.25)",
  padding: "6px 0",
};
