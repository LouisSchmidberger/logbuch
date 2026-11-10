import { addDays, atCurrentPeriod, isPeriodField } from './dates.js?v=8aaa0e5b67';
import { runtime, state } from './state.js?v=8aaa0e5b67';
import { app, isSubpageView, subpageBack } from './navigation.js?v=8aaa0e5b67';
import { haptic } from './theme.js?v=8aaa0e5b67';
import { commitLayoutOrder } from './type-change.js?v=8aaa0e5b67';
import { stickyHeaderBottom } from './save.js?v=8aaa0e5b67';
import { closeRowMenu, openRowMenu } from './row-view.js?v=8aaa0e5b67';
import { render } from './main-view.js?v=8aaa0e5b67';

// --- Swipe-Navigation (Heute/Woche/Monat/Jahr: vorheriger/nächster Zeitraum) --------
let touchStartX = null;
let touchStartY = null;
const SWIPE_THRESHOLD = 50;
// Höher als SWIPE_THRESHOLD: ein Wisch auf einer Unterseite (z.B. "Verwalten") verlässt
// die Seite komplett statt nur den Zeitraum zu wechseln - dort ist "aus Versehen
// ausgelöst" ärgerlicher als bei Heute/Woche/Monat/Jahr, deshalb absichtlich weniger
// empfindlich.
const SWIPE_THRESHOLD_SUBPAGE = 100;
export const SWIPEABLE_VIEWS = ['today', 'week', 'month', 'year'];

// Vorheriger/nächster Zeitraum der aktuellen Ansicht - gemeinsam für Wischen und die
// ‹ ›-Pfeile. Merkt sich die Richtung für die Rutsch-Animation (renderApp): ohne sie
// änderte sich beim Wischen nur still der Inhalt, und zwei Tage in "Heute" sehen sich oft
// zum Verwechseln ähnlich.
export function shiftPeriod(dir) {
  if (dir > 0 && atCurrentPeriod()) return; // Zukunft gesperrt, siehe isFutureKey
  if (state.view === 'today') {
    state.currentDate = addDays(state.currentDate, dir);
  } else if (state.view === 'week') {
    state.weekAnchor = addDays(state.weekAnchor, dir * 7);
  } else if (state.view === 'month') {
    const d = new Date(state.monthAnchor);
    d.setMonth(d.getMonth() + dir);
    state.monthAnchor = d;
  } else if (state.view === 'year') {
    state.yearAnchor += dir;
  } else {
    return;
  }
  runtime.pendingPeriodSlide = dir;
}

// --- Zeilen-Menü per Long-Press/Rechtsklick (Heute) ------------------------
// Reine Abkürzung zum ⋮-Button (siehe renderRowMenuButton), nie der einzige Weg - auf
// Feld-Zeilen und Gruppen-Überschriften (dort statt des Auf-/Zuklappens). Touch/Stift über einen eigenen Timer (iOS Safari feuert beim Long-Press kein
// 'contextmenu'), Maus über den Rechtsklick ('contextmenu'). Ausgenommen sind alle
// Stellen, an denen Gedrückthalten schon etwas anderes bedeutet: Eingabefelder
// (Einfügen/Cursor setzen), der Schieberegler (Halten = Ziehen beginnen) und das Menü
// selbst. Der Feldname ist bewusst NICHT ausgenommen - Android macht aus einem langen
// Drücken keinen Klick mehr, ohne Long-Press-Behandlung passierte dort sonst gar nichts.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;
let longPress = null;
export let lastPointerType = 'mouse';
// Nach einem Long-Press auf einen Wert-Button würde das Loslassen zusätzlich einen
// normalen Klick auslösen und damit ungewollt den Wert setzen - der erste Klick nach
// dem Öffnen wird deshalb verschluckt (Capture-Listener unten). Bei jedem neuen
// pointerdown zurückgesetzt, falls der Klick ausnahmsweise gar nicht kommt - sonst
// würde stattdessen der nächste echte Klick verschluckt.
let suppressNextClick = false;

function rowMenuKeyAt(target) {
  if (state.view !== 'today' || target.closest('input, textarea, select, .slider-row, .row-menu, .note-editor')) return null;
  return target.closest('.habit-row, .number-box, .section-head')?.querySelector('.row-menu-trigger')?.dataset.menu ?? null;
}
function cancelLongPress() {
  if (!longPress) return;
  clearTimeout(longPress.timer);
  longPress = null;
}

// --- Felder-Reihenfolge per Drag (Tab "Felder") ---------------------------
// Während des Ziehens wird NIE render() aufgerufen (das würde den gesamten #app-Inhalt
// ersetzen und damit die Pointer-Capture/laufende Geste kaputtmachen) — stattdessen nur
// direkte Style-Änderungen an den vorhandenen Zeilen. Erst beim Loslassen wird die neue
// Reihenfolge in state.habits übernommen, gespeichert und einmal sauber neu gerendert.
let dragState = null;
// "Scharfschalt"-Phase vor dem eigentlichen Drag: ein schneller Scroll-Wisch, der
// zufällig über dem schmalen Drag-Handle beginnt, soll NICHT sofort die Reihenfolge
// durcheinanderbringen. Erst nach kurzem, ruhigem Halten (ohne nennenswerte Bewegung)
// wird tatsächlich gezogen – ein normaler Scroll-Wisch bricht das vorher ab.
let dragArm = null;
const DRAG_ARM_DELAY_MS = 150;
// 16 statt vorher 10: ein aufsetzender Finger wackelt leicht, mit 10px brach das
// Greifen oft ab und man musste 2-3 Mal ansetzen.
const DRAG_ARM_MOVE_TOLERANCE = 16;

// Ein Feld (kein Zeitraum-Feld, keine Gruppe) zieht man über Gruppengrenzen hinweg
// (Nutzer-Entscheidung 2026-11-10, wie fieldMoveStep für ↑/↓): dafür steht jede sichtbare
// Zeile einzeln in einer flachen Liste - Felder der obersten Ebene, Kopfzeilen der Gruppen,
// deren Felder bzw. der "Noch leer"-Hinweis - und am Ende jeder Gruppe ein Ablagebereich
// (type 'end'), den die Liste beim Ziehen als freien Platz unten in jeder Gruppe zeigt
// (.manage-list--field-drag). Ohne ihn lägen "letztes Feld der Gruppe" und "direkt unter der
// Gruppe" an derselben Stelle und ein Pixel entschiede. Die übrigen Zeilen rücken einzeln auf
// wie beim Ziehen innerhalb eines Behälters. Wohin das Feld kommt, sagt die Zeile darüber:
// Kopfzeile oder Feld einer Gruppe = in diese Gruppe, Ablagebereich oder Feld der obersten
// Ebene = oberste Ebene. Die gezogene Zeile rückt dabei schon ein bzw. aus.
function fieldDragModel(row) {
  if (row.dataset.orderType !== 'habit') return null;
  const h = state.habits.find((x) => x.defId === row.dataset.orderId);
  if (!h || isPeriodField(h)) return null;
  const list = row.closest('.manage-list');
  const topBefore = row.getBoundingClientRect().top;
  // Ablagebereich so hoch wie eine halbe Zeile: die Zeilen sind je nach Breite und Textgröße
  // sehr verschieden hoch (am Handy brechen die Knöpfe um).
  list.style.setProperty('--drag-end-zone', `${Math.round(row.getBoundingClientRect().height * 0.6)}px`);
  list.classList.add('manage-list--field-drag');
  const els = [];
  for (const c of list.children) {
    if (c.dataset.orderType === 'habit') els.push({ el: c, sec: null, type: 'field', id: c.dataset.orderId });
    else if (c.dataset.orderType === 'section') {
      const sec = c.dataset.orderId;
      els.push({ el: c.querySelector('.manage-section-head'), sec, type: 'head', id: sec });
      const box = c.querySelector('.manage-section-children');
      for (const k of box.children) {
        els.push(k.dataset.orderType === 'habit' ? { el: k, sec, type: 'field', id: k.dataset.orderId } : { el: k, sec, type: 'empty' });
      }
      const rb = box.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(box).paddingBottom) || 0;
      els.push({ el: null, sec, type: 'end', rect: { top: rb.bottom - pad, height: pad } });
    }
  }
  const from = els.findIndex((x) => x.el === row);
  const rects = els.map((x) => x.rect ?? x.el.getBoundingClientRect());
  const groupBox = list.querySelector('.manage-section-children');
  const indent = groupBox ? groupBox.getBoundingClientRect().left - list.getBoundingClientRect().left : 0;
  return {
    cross: true, list, els, rows: els.map((x) => x.el), fromIndex: from, toIndex: from,
    tops: rects.map((rc) => rc.top + window.scrollY), heights: rects.map((rc) => rc.height),
    slot: rects[from].height, indent, origin: els[from].sec, target: els[from].sec,
    // Der freie Platz in den Gruppen darüber schiebt die Zeile nach unten - die Zieh-Rechnung
    // startet deshalb von ihrer neuen Lage, damit sie unter dem Finger bleibt.
    startOffset: rects[from].top - topBefore,
  };
}
function fieldDragShift(ds, i, toIndex) {
  if (i === ds.fromIndex) return 0;
  if (toIndex > ds.fromIndex && i > ds.fromIndex && i <= toIndex) return -ds.slot;
  if (toIndex < ds.fromIndex && i < ds.fromIndex && i >= toIndex) return ds.slot;
  return 0;
}
// Ziel-Behälter (Gruppen-Id oder null) für den Platz toIndex.
function fieldDragTarget(ds, toIndex) {
  const from = ds.fromIndex;
  const prev = ds.els[toIndex > from ? toIndex : toIndex < from ? toIndex - 1 : from - 1];
  if (!prev || prev.type === 'end') return null;
  return prev.sec;
}
function updateFieldDragPosition() {
  const ds = dragState;
  const { tops, heights, fromIndex: from, rows } = ds;
  const last = rows.length - 1;
  const minDelta = tops[0] - tops[from];
  const maxDelta = tops[last] + heights[last] - (tops[from] + heights[from]);
  const rawDelta = ds.lastClientY - ds.startY + (window.scrollY - ds.startScrollY) - ds.startOffset;
  const deltaY = Math.max(minDelta, Math.min(maxDelta, rawDelta));
  const dragTop = tops[from] + deltaY;
  const dragBottom = dragTop + heights[from];
  let toIndex = from;
  if (deltaY > 0) {
    for (let i = from + 1; i < rows.length; i++) if (dragBottom > tops[i] + heights[i] / 2) toIndex = i;
  } else if (deltaY < 0) {
    for (let i = from - 1; i >= 0; i--) if (dragTop < tops[i] + heights[i] / 2) toIndex = i;
  }
  const target = fieldDragTarget(ds, toIndex);
  const dx = (target ? ds.indent : 0) - (ds.origin ? ds.indent : 0);
  // Einrücken über den Rand statt per Verschieben - sonst ragte die Zeile rechts hinaus.
  ds.row.style.marginLeft = dx ? `${dx}px` : '';
  ds.row.style.transform = `translateY(${deltaY}px)`;
  if (target !== ds.target) { ds.target = target; haptic(); }
  if (toIndex === ds.toIndex) return;
  ds.toIndex = toIndex;
  rows.forEach((r, i) => {
    if (!r || r === ds.row) return;
    const shift = fieldDragShift(ds, i, toIndex);
    r.style.transition = 'transform 150ms ease';
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}
// Neue Reihenfolge des Ziel-Behälters für commitLayoutOrder, oder null ohne Änderung.
function fieldDragDropItems(ds) {
  const { els, fromIndex: from, toIndex, target, origin } = ds;
  if (toIndex === from && target === origin) return null;
  const order = els.filter((_, i) => i !== from);
  order.splice(toIndex, 0, els[from]);
  const items = [];
  for (const x of order) {
    if (x === els[from]) items.push(target === origin ? { type: 'habit', id: x.id } : { type: 'habit', id: x.id, sectionId: target });
    else if (target === null && x.type === 'head') items.push({ type: 'section', id: x.id });
    else if (x.type === 'field' && x.sec === target) items.push({ type: 'habit', id: x.id });
  }
  return items;
}

// Position der gezogenen Zeile + Verschieben der übrigen. Rechnet die inzwischen
// gescrollte Strecke mit ein (scrollY - startScrollY), da die Seite beim Ziehen am Rand
// von selbst weiterscrollt (siehe updateDragAutoScroll) - sonst bliebe die Zeile beim
// Scrollen nicht unter dem Finger.
function updateDragPosition() {
  if (dragState.cross) { updateFieldDragPosition(); return; }
  // Auf die Liste begrenzt: weiter als bis zum ersten/letzten Platz lässt sich die Zeile
  // nicht ziehen (vorher schoss sie beliebig weit darüber hinaus und sprang erst beim
  // Loslassen zurück).
  const { tops, heights, fromIndex: from, rows } = dragState;
  const last = rows.length - 1;
  const minDelta = tops[0] - tops[from];
  const maxDelta = tops[last] + heights[last] - (tops[from] + heights[from]);
  const rawDelta = dragState.lastClientY - dragState.startY + (window.scrollY - dragState.startScrollY);
  const deltaY = Math.max(minDelta, Math.min(maxDelta, rawDelta));
  dragState.row.style.transform = `translateY(${deltaY}px)`;

  // Zielplatz über die in Zugrichtung vorne liegende Kante: nach unten zählt die
  // Unterkante, nach oben die Oberkante - sobald sie die Mitte eines Geschwisters
  // überquert, tauschen beide. Nicht die Mitte des gezogenen Elements: bei einem großen
  // Block (Gruppe) kam die wegen der Begrenzung auf die Liste nie an der Mitte des
  // letzten/ersten kleinen Elements vorbei, er blieb einen Platz zu früh hängen.
  const dragTop = tops[from] + deltaY;
  const dragBottom = dragTop + heights[from];
  let toIndex = from;
  if (deltaY > 0) {
    for (let i = from + 1; i < rows.length; i++) if (dragBottom > tops[i] + heights[i] / 2) toIndex = i;
  } else if (deltaY < 0) {
    for (let i = from - 1; i >= 0; i--) if (dragTop < tops[i] + heights[i] / 2) toIndex = i;
  }
  if (toIndex === dragState.toIndex) return;
  dragState.toIndex = toIndex;
  rows.forEach((r, i) => {
    if (r === dragState.row) return;
    let shift = 0;
    if (toIndex > from && i > from && i <= toIndex) shift = -dragState.slot;
    else if (toIndex < from && i < from && i >= toIndex) shift = dragState.slot;
    r.style.transition = 'transform 150ms ease';
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

// Automatisches Scrollen, solange man die Zeile nahe an den oberen (unter dem
// angepinnten Seitenkopf) oder unteren Bildschirmrand hält - sonst ließ sich ein Feld
// nur in Etappen weit nach oben/unten verschieben. Je näher am Rand, desto schneller.
// Läuft per requestAnimationFrame, damit es auch weiterscrollt, wenn der Finger still
// am Rand steht (dann kommen keine pointermove-Events).
const DRAG_SCROLL_ZONE = 90;
const DRAG_SCROLL_MAX_SPEED = 10; // px pro Frame
let dragScrollFrame = null;
function dragScrollSpeed() {
  const top = stickyHeaderBottom();
  const bottom = window.visualViewport?.height ?? window.innerHeight;
  const y = dragState.lastClientY;
  if (y < top + DRAG_SCROLL_ZONE) return -DRAG_SCROLL_MAX_SPEED * Math.min(1, (top + DRAG_SCROLL_ZONE - y) / DRAG_SCROLL_ZONE);
  if (y > bottom - DRAG_SCROLL_ZONE) return DRAG_SCROLL_MAX_SPEED * Math.min(1, (y - (bottom - DRAG_SCROLL_ZONE)) / DRAG_SCROLL_ZONE);
  return 0;
}
function updateDragAutoScroll() {
  if (dragScrollFrame !== null) return;
  const step = () => {
    dragScrollFrame = null;
    if (!dragState) return;
    const speed = dragScrollSpeed();
    if (!speed) return;
    // Nicht über die Liste hinaus scrollen - ist ihr Ende bzw. Anfang schon im Bild,
    // gibt es in der Richtung keinen Platz mehr, zu dem man ziehen könnte.
    const list = (dragState.list ?? dragState.row.parentElement).getBoundingClientRect();
    const top = stickyHeaderBottom();
    const bottom = window.visualViewport?.height ?? window.innerHeight;
    if ((speed > 0 && list.bottom <= bottom) || (speed < 0 && list.top >= top)) return;
    const before = window.scrollY;
    window.scrollBy(0, speed);
    if (window.scrollY === before) return; // Anfang/Ende der Seite erreicht
    updateDragPosition();
    dragScrollFrame = requestAnimationFrame(step);
  };
  dragScrollFrame = requestAnimationFrame(step);
}
function stopDragAutoScroll() {
  if (dragScrollFrame !== null) cancelAnimationFrame(dragScrollFrame);
  dragScrollFrame = null;
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initGestures() {
  // Auf Unterseiten (Verwalten/Über Logbuch) ersetzt ein Wisch nach rechts (dieselbe
  // Richtung, die in den Tab-Ansichten "vorheriger Zeitraum" bedeutet) den ←-Button -
  // gängige Geste für "zurück", passend zum sonstigen Swipe-Vokabular der App.
  app.addEventListener('touchstart', (e) => {
    // Ein Wisch, der innerhalb einer eigenen horizontal scrollbaren Zeile beginnt (z.B. die
    // Feld-Buttons, wenn deren Bezeichnungen den Platz sprengen) oder auf dem Schieberegler
    // selbst beginnt (der Drag muss den Wert setzen, nicht den Tag wechseln), soll dort
    // wirken statt die Ansicht zu wechseln. Ebenso in einer Textarea (Notiz-Editor):
    // dort markiert ein waagerechtes Ziehen Text.
    if ((!SWIPEABLE_VIEWS.includes(state.view) && !isSubpageView(state.view)) || e.touches.length !== 1 || e.target.closest('.habit-options, .tabs, .slider-row, textarea')) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  app.addEventListener('touchend', (e) => {
    const subpage = isSubpageView(state.view);
    if (touchStartX === null || (!SWIPEABLE_VIEWS.includes(state.view) && !subpage)) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;
    if (Math.abs(dx) < (subpage ? SWIPE_THRESHOLD_SUBPAGE : SWIPE_THRESHOLD) || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const dir = dx < 0 ? 1 : -1;
    state.rowMenu = null;

    if (subpage) {
      if (dir === -1) { subpageBack(); render(); }
      return;
    }
    shiftPeriod(dir);
    render();
  }, { passive: true });
  app.addEventListener('pointerdown', (e) => {
    suppressNextClick = false;
    lastPointerType = e.pointerType;
    cancelLongPress();
    if (e.pointerType === 'mouse') return;
    const menuKey = rowMenuKeyAt(e.target);
    if (!menuKey) return;
    longPress = {
      pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      timer: setTimeout(() => {
        longPress = null;
        suppressNextClick = true;
        haptic();
        openRowMenu(menuKey);
      }, LONG_PRESS_MS),
    };
  });
  app.addEventListener('pointermove', (e) => {
    if (!longPress || e.pointerId !== longPress.pointerId) return;
    if (Math.hypot(e.clientX - longPress.startX, e.clientY - longPress.startY) > LONG_PRESS_MOVE_TOLERANCE) cancelLongPress();
  });
  // pointercancel: der Browser übernimmt die Geste selbst (z.B. Scrollen der Seite).
  app.addEventListener('pointerup', cancelLongPress);
  app.addEventListener('pointercancel', cancelLongPress);
  app.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    // Light-Dismiss: bei offenem Zeilen-Menü schließt ein Tipp irgendwo außerhalb nur das
    // Menü und löst sonst nichts aus - weder direkt das Menü eines anderen Feldes noch z.B.
    // einen Wert, wenn man eigentlich nur das Menü loswerden wollte. Ausnahmen: das Menü
    // selbst und der eigene Auslöser (⋮ bzw. Feldname, normales Zuklappen). Nur für Zeige-Geräte
    // (e.detail > 0): per Tastatur ausgelöste Klicks (detail 0) sind nach einem bewussten
    // Wegnavigieren gemeint und laufen normal durch - die schließen das Menü dann über den
    // Klick-Handler (state.rowMenu = null bei jeder anderen Aktion).
    if (state.rowMenu && e.detail > 0
        && !e.target.closest(`.row-menu, [data-menu="${state.rowMenu}"]`)) {
      e.stopPropagation();
      e.preventDefault();
      closeRowMenu();
    }
  }, true);
  // Rechtsklick mit der Maus - und auf Android, wo der Long-Press zusätzlich ein
  // 'contextmenu' feuert (je nach Gerät vor oder nach dem eigenen Timer), damit dort
  // weder das Browser-Kontextmenü erscheint noch das Menü doppelt geöffnet wird.
  app.addEventListener('contextmenu', (e) => {
    const menuKey = rowMenuKeyAt(e.target);
    if (!menuKey) return;
    e.preventDefault();
    if (lastPointerType !== 'mouse') {
      cancelLongPress();
      suppressNextClick = true;
    }
    if (state.rowMenu !== menuKey) openRowMenu(menuKey);
  });
  app.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-action="drag-handle"]');
    if (!handle) return;
    // Gezogen wird ein .manage-item: ein Feld oder (auf oberster Ebene) eine ganze Gruppe
    // als Block - innerhalb ihres Behälters (oberste Ebene bzw. Felder einer Gruppe).
    const row = handle.closest('.manage-item');
    const rows = [...row.parentElement.children].filter((r) => r.classList.contains('manage-item'));
    const fromIndex = rows.indexOf(row);

    dragArm = { pointerId: e.pointerId, row, rows, fromIndex, startY: e.clientY, startX: e.clientX };
    dragArm.timer = setTimeout(() => {
      if (!dragArm) return;
      const armed = dragArm;
      dragArm = null;
      // Elemente sind unterschiedlich hoch (ein Gruppen-Block vs. eine Feld-Zeile) - deshalb
      // die Original-Positionen aller Geschwister merken statt einer einheitlichen
      // Zeilenhöhe. slot = Platz, den das gezogene Element samt Abstand einnimmt; um genau
      // den rücken die übersprungenen Geschwister auf.
      // Eine Gruppe wird beim Ziehen auf ihre Kopfzeile zusammengeklappt - ein großer Block
      // ist sonst sperrig. Vor dem Messen, da sich dadurch alle Positionen verschieben; der
      // Griff sitzt in der Kopfzeile und bleibt dabei unter dem Finger.
      if (armed.row.classList.contains('manage-section')) armed.row.classList.add('manage-section--drag-collapsed');
      const cross = fieldDragModel(armed.row);
      if (cross) {
        dragState = { ...cross, pointerId: armed.pointerId, row: armed.row, startY: armed.startY, startScrollY: window.scrollY, lastClientY: armed.startY };
        dragState.row.setPointerCapture(dragState.pointerId);
        dragState.row.classList.add('manage-row--dragging');
        updateFieldDragPosition();
        haptic();
        return;
      }
      const rects = armed.rows.map((r) => r.getBoundingClientRect());
      const tops = rects.map((rc) => rc.top + window.scrollY);
      const heights = rects.map((rc) => rc.height);
      const i = armed.fromIndex;
      const slot = i < armed.rows.length - 1 ? tops[i + 1] - tops[i] : i > 0 ? tops[i] + heights[i] - (tops[i - 1] + heights[i - 1]) : heights[i];
      dragState = { pointerId: armed.pointerId, row: armed.row, rows: armed.rows, fromIndex: i, toIndex: i, startY: armed.startY, startScrollY: window.scrollY, lastClientY: armed.startY, tops, heights, slot };
      dragState.row.setPointerCapture(dragState.pointerId);
      dragState.row.classList.add('manage-row--dragging');
      haptic(); // spürbare Rückmeldung, dass das Feld jetzt "in der Hand" ist
    }, DRAG_ARM_DELAY_MS);
  });
  app.addEventListener('pointermove', (e) => {
    if (dragArm && e.pointerId === dragArm.pointerId) {
      const dx = e.clientX - dragArm.startX;
      const dy = e.clientY - dragArm.startY;
      if (Math.hypot(dx, dy) > DRAG_ARM_MOVE_TOLERANCE) {
        clearTimeout(dragArm.timer);
        dragArm = null;
      }
      return;
    }
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    dragState.lastClientY = e.clientY;
    updateDragPosition();
    updateDragAutoScroll();
  });
  app.addEventListener('pointerup', async (e) => {
    if (dragArm && e.pointerId === dragArm.pointerId) {
      clearTimeout(dragArm.timer);
      dragArm = null;
      return;
    }
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    stopDragAutoScroll();
    const { row, rows, fromIndex, toIndex } = dragState;
    row.releasePointerCapture(e.pointerId);
    row.classList.remove('manage-row--dragging', 'manage-section--drag-collapsed');
    rows.forEach((r) => { if (r) { r.style.transform = ''; r.style.transition = ''; } });
    const ended = dragState;
    dragState = null;
    if (ended.cross) {
      ended.list.classList.remove('manage-list--field-drag');
      ended.row.style.marginLeft = '';
      const drop = fieldDragDropItems(ended);
      if (drop) await commitLayoutOrder(drop);
      return;
    }
    if (toIndex === fromIndex) return;

    const reordered = [...rows];
    const [movedEl] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, movedEl);
    await commitLayoutOrder(reordered.map((r) => ({ type: r.dataset.orderType, id: r.dataset.orderId })));
  });
}
