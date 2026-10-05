/*
 * What the site sells, and how it prints money.
 *
 * ONE COPY, because there were about to be three: the order sheet had its own, and each
 * product page needs the same prices and the same arithmetic to show a Buy button that
 * agrees with the sheet it opens.
 *
 * THESE PRICES ARE FOR DISPLAY ONLY. The browser never sends a price. It posts which SKUs
 * and how many; Paddock prices the order, records it, and answers with the Razorpay order
 * to open. A stale figure here shows a wrong subtotal for a moment and still charges the
 * right amount, and order-sheet.js reconciles against the server's own numbers before
 * Razorpay opens. Paddock's pricing.test.mjs pins these values against its catalogue, so
 * changing one there fails a test naming this file.
 *
 * The words on an invoice come from Paddock, not from here.
 */
(() => {
  'use strict';

  /*
   * `label` is the invoice wording, kept in step with Paddock. `short` is what a card or a
   * sheet row says, which is the shorter thing people actually call it. Both are here so
   * the two never drift apart by being written out separately in four pages of markup.
   */
  const ITEMS = [
    { sku: 'adapter', price: 499, label: 'Portable Charging Adapter', short: 'Adapter' },
    { sku: 'dock', price: 2999, label: 'Vehicle Dock', short: 'Vehicle Dock' },
    { sku: 'chg6a', price: 2199, label: '6A Charger', short: '6A Charger' },
    { sku: 'chg10a', price: 2699, label: '10A Charger', short: '10A Charger' },
  ];

  /** MAX_QTY_PER_SKU on the server, which is the one that actually counts. */
  const MAX_QTY = 10;

  /*
   * What Razorpay takes, mirroring GATEWAY_FEE_RATE in Paddock's pricing.js.
   *
   * Duplicating a business constant in the browser is a cost, and it buys the button
   * telling the truth. The fee is grossed up and added on top server side, so an item
   * total on a Buy button would be a smaller number than the amount the Razorpay window
   * then asks for. Razorpay is always opened against the server's amountPaise, so this
   * only ever decides what is printed, never what is charged.
   */
  const GATEWAY_FEE_RATE = 0.024184309;

  /** Matches round2 in Paddock's pricingCore.js, so the two agree to the paisa. */
  const round2 = (x) => Math.sign(x) * Math.round(Math.abs(x) * 100) / 100;

  /** Matches grossUpForFee: the customer pays the fee on top, grossed up rather than marked up. */
  const grossUp = (net) => round2(net / (1 - GATEWAY_FEE_RATE));

  /** Paise only when there are paise, so a round figure does not read as ₹499.00. */
  const money = (n) => {
    const hasPaise = Math.round(Math.abs(n) * 100) % 100 !== 0;
    return `₹${new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: hasPaise ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(n)}`;
  };

  const bySku = Object.fromEntries(ITEMS.map((it) => [it.sku, it]));
  const priceOf = (sku) => (bySku[sku] ? bySku[sku].price : 0);

  window.gridCatalogue = {
    ITEMS,
    MAX_QTY,
    GATEWAY_FEE_RATE,
    round2,
    grossUp,
    money,
    priceOf,
    has: (sku) => Object.prototype.hasOwnProperty.call(bySku, sku),
  };
})();
