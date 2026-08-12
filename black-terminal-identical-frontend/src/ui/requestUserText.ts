export type TextInputRequest = {
  title?: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
};

let dismissActive: (() => void) | null = null;

export function requestUserText(request: TextInputRequest): Promise<string | null> {
  if (typeof document === "undefined" || !document.body) return Promise.resolve(null);
  dismissActive?.();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    const form = document.createElement("form");
    const title = document.createElement("strong");
    const message = document.createElement("p");
    const field = request.multiline ? document.createElement("textarea") : document.createElement("input");
    const actions = document.createElement("div");
    const cancel = document.createElement("button");
    const confirm = document.createElement("button");
    let settled = false;

    overlay.setAttribute("role", "presentation");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "2147483647", display: "grid", placeItems: "center",
      padding: "24px", background: "rgba(0,0,0,.72)", backdropFilter: "blur(10px)"
    });
    Object.assign(form.style, {
      width: "min(460px, calc(100vw - 32px))", display: "grid", gap: "14px", padding: "20px",
      color: "#f5f5f5", background: "rgba(7,7,9,.96)", border: "1px solid rgba(180,0,35,.65)",
      borderRadius: "12px", boxShadow: "0 22px 70px rgba(0,0,0,.7), 0 0 32px rgba(150,0,30,.15)",
      fontFamily: "inherit"
    });
    title.textContent = request.title || "Black Terminal";
    Object.assign(title.style, { fontSize: "12px", letterSpacing: ".12em", textTransform: "uppercase" });
    message.textContent = request.message;
    Object.assign(message.style, { margin: "0", color: "#b9b9bf", fontSize: "12px", lineHeight: "1.55" });
    field.value = request.defaultValue || "";
    field.placeholder = request.placeholder || "";
    field.setAttribute("aria-label", request.message);
    Object.assign(field.style, {
      width: "100%", boxSizing: "border-box", padding: "11px 12px", color: "#fff", background: "#09090b",
      border: "1px solid #3a3a40", borderRadius: "7px", outline: "none", resize: "vertical", font: "inherit"
    });
    if (request.multiline && field instanceof HTMLTextAreaElement) field.rows = 8;
    Object.assign(actions.style, { display: "flex", justifyContent: "flex-end", gap: "8px" });
    cancel.type = "button";
    cancel.textContent = "Cancel";
    confirm.type = "submit";
    confirm.textContent = request.confirmLabel || "Apply";
    for (const button of [cancel, confirm]) {
      Object.assign(button.style, {
        minWidth: "92px", padding: "9px 13px", borderRadius: "6px", border: "1px solid #45454b",
        color: "#fff", background: "#111116", cursor: "pointer", font: "inherit"
      });
    }
    Object.assign(confirm.style, { background: "#6e0017", borderColor: "#b60028" });

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (dismissActive === dismiss) dismissActive = null;
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(value);
    };
    const dismiss = () => finish(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    dismissActive = dismiss;
    cancel.addEventListener("click", dismiss);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) dismiss(); });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(field.value);
    });
    document.addEventListener("keydown", onKeyDown);
    actions.append(cancel, confirm);
    form.append(title, message, field, actions);
    overlay.append(form);
    document.body.append(overlay);
    queueMicrotask(() => { field.focus(); field.select(); });
  });
}
