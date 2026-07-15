import { useEffect, useState } from "react";
import { Activity, Ban, FileSearch, Pencil, X } from "lucide-react";
import type { OrderUpdate } from "../execution/types";
import { cancelVenueOrderViaApi, modifyVenueOrderViaApi } from "../portfolio/portfolioApiClient";
import { canonicalOrderKey } from "./canonicalOrder";

type Props = {
  order: OrderUpdate;
  x: number;
  y: number;
  onClose: () => void;
  onSynchronized?: () => void | Promise<unknown>;
};

export function OrderManagementMenu({ order, x, y, onClose, onSynchronized }: Props) {
  const [view, setView] = useState<"menu" | "modify" | "details">("menu");
  const [price, setPrice] = useState(String(order.venuePriceString || order.price || ""));
  const [quantity, setQuantity] = useState(String(order.remainingQuantity ?? order.quantity ?? ""));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    const click = () => onClose();
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", click);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", click);
    };
  }, [onClose]);

  async function refreshAndClose(message: string) {
    setStatus(message);
    await onSynchronized?.();
    onClose();
  }

  async function cancelOrder() {
    if (!window.confirm(`Cancel ${order.exchange.toUpperCase()} order ${order.venueOrderId || order.orderId}?`)) return;
    setBusy(true);
    setStatus("CANCEL PENDING - WAITING FOR VENUE ACK");
    try {
      await cancelVenueOrderViaApi(order);
      await refreshAndClose("CANCEL ACKNOWLEDGED");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  async function modifyOrder() {
    const nextPrice = Number(price);
    const nextQuantity = Number(quantity);
    if (!(nextPrice > 0) || !(nextQuantity > 0)) {
      setStatus("PRICE AND QUANTITY MUST BE POSITIVE");
      return;
    }
    setBusy(true);
    setStatus("MODIFY PENDING - WAITING FOR VENUE ACK");
    try {
      await modifyVenueOrderViaApi(order, { limitPrice: nextPrice, quantity: nextQuantity });
      await refreshAndClose("MODIFY ACKNOWLEDGED");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  return (
    <div
      className="order-management-menu"
      style={{ left: Math.min(x, window.innerWidth - 294), top: Math.min(y, window.innerHeight - 350) }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <header>
        <div><b>{order.symbol}</b><span>{order.exchange.toUpperCase()} / {order.side?.toUpperCase()}</span></div>
        <button type="button" aria-label="Close order menu" onClick={onClose}><X size={14} /></button>
      </header>
      {view === "menu" && (
        <div className="order-management-actions">
          <button type="button" onClick={() => setView("modify")}><Pencil size={13} /> Modify Order</button>
          <button type="button" className="danger" disabled={busy} onClick={() => void cancelOrder()}><Ban size={13} /> Cancel Order</button>
          <button type="button" disabled title="Bybit cannot convert an existing standard order into a native Chase strategy without cancel-and-replace."><Activity size={13} /> Chase Order <em>Not attachable</em></button>
          <button type="button" onClick={() => setView("details")}><FileSearch size={13} /> Inspect Details</button>
        </div>
      )}
      {view === "modify" && (
        <div className="order-management-form">
          <label>Price<input type="number" min="0" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
          <label>Remaining Quantity<input type="number" min="0" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <div><button type="button" onClick={() => setView("menu")}>Back</button><button type="button" className="primary" disabled={busy} onClick={() => void modifyOrder()}>Submit Modify</button></div>
        </div>
      )}
      {view === "details" && (
        <dl className="order-management-details">
          <dt>Canonical Key</dt><dd>{canonicalOrderKey(order)}</dd>
          <dt>Venue Order ID</dt><dd>{order.venueOrderId || order.orderId}</dd>
          <dt>Venue Price</dt><dd>{order.venuePriceString || order.price || "-"}</dd>
          <dt>Status</dt><dd>{order.status}</dd>
          <dt>Source</dt><dd>{order.externallyCreated ? "BYBIT EXTERNAL" : "BLACK TERMINAL"}</dd>
          <button type="button" onClick={() => setView("menu")}>Back</button>
        </dl>
      )}
      {status && <div className="order-management-status">{status}</div>}
    </div>
  );
}
