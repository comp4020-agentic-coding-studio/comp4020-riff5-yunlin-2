// Far Bank --- press and drag (mouse/touch/pen) or hold (spacebar) to charge
// a hop across the river, release to land it. One mechanic: judge the
// charge. Land short or long and the round ends in the water. The rules in
// game-logic.ts are the contract; everything here is timing, drawing and
// input.
import { chargeToDistance, nextGap, resolveJump, type Gap, type JumpOutcome } from "./game-logic.ts";

const VW = 800;
const VH = 600;
const WATER_Y = 380;
const PLAYER_X = 220;
const MAX_CHARGE_MS = 900;
const MAX_DISTANCE = 260;
/** Drag distance, in virtual (canvas) units, that fills the charge meter.
 *  Deliberately smaller than MAX_DISTANCE so a full charge is a comfortable
 *  swipe rather than a drag across most of the board. */
const DRAG_RANGE = 180;
const JUMP_MS = 380;
const SETTLE_MS = 160;
const SPLASH_MS = 550;
const START_STONE_WIDTH = 74;
const BEST_KEY = "far-bank-best";
const HISTORY_KEY = "far-bank-history";
const MAX_HISTORY = 8;
const SPRITE_COUNT = 9;
/** Frame index (1-based, into squirrel-N.png) for each phase. A single held
 *  pose for the hop reads as a jump; cycling frames mid-arc looked like a
 *  running loop stuck in place instead of one leap across the gap. */
const IDLE_FRAME = 1;
const JUMP_FRAME = 3;

type Phase = "ready" | "charging" | "airborne" | "settling" | "splash" | "gameover";

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Reads the current stored value before writing --- a second tab of the
 *  same game can raise it between this tab's load and this save, and an
 *  unconditional write would silently regress that tab's higher best. */
function saveBest(value: number): void {
  try {
    if (value > loadBest()) localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // storage unavailable (private browsing) --- the run still plays fine
  }
}

function loadHistory(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function saveHistory(history: number[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // storage unavailable (private browsing) --- the run still plays fine
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

class FarBank {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scoreEl: HTMLElement;
  private readonly historyEl: HTMLElement;
  private readonly reducedMotion: boolean;

  private phase: Phase = "ready";
  private score = 0;
  private best = loadBest();
  /** Most recent run first, capped at MAX_HISTORY --- persisted so a reload
   *  doesn't lose the record of prior attempts. */
  private history = loadHistory();

  private currentStoneWorldX = 0;
  private currentStoneWidth = START_STONE_WIDTH;
  private gap: Gap = nextGap(0, Math.random, MAX_DISTANCE);
  private scrollOffset = 0;

  private chargeStart = 0;
  private inputMode: "hold" | "drag" = "hold";
  private dragStartVirtualX = 0;
  private dragChargeFraction = 0;
  private hopStart = 0;
  private hopFrom = 0;
  private jumpDistance = 0;
  private outcome: JumpOutcome = "stone";
  private settleStart = 0;
  private settleFrom = 0;
  private splashStart = 0;

  /** The supplied landscape photo, drawn cover-fit behind the water --- a
   *  static backdrop, unlike the drifting clouds it replaces. Drawing waits
   *  on `backgroundLoaded` so a slow first load shows the plain sky colour
   *  instead of a half-drawn image. */
  private readonly background = new Image();
  private backgroundLoaded = false;

  /** Squirrel running-cycle frames, cut from a hand-drawn sprite sheet.
   *  Frame 1 is the standing/idle pose; 2 onward run through a leap. Each
   *  loads independently --- `spritesLoaded[i]` gates drawing that one frame
   *  so a slow load never shows a blank/broken image mid-jump. */
  private readonly sprites: HTMLImageElement[] = [];
  private readonly spritesLoaded: boolean[] = [];

  /** Ambient ripples, each a pure function of time --- no per-frame state to
   *  track. `offset` staggers them so they don't all pulse in lockstep;
   *  `period` is how long one expand-and-fade cycle takes. */
  /** Drawn over the (static) background photo so the sky still reads as
   *  moving air --- fixed screen positions, wrapped across a band wider
   *  than the canvas so a cloud leaving one edge is already entering the
   *  other. Reduced-motion holds them at their base position. */
  private readonly clouds = [
    { baseX: 90, y: 65, scale: 1.1, speed: 0.012 },
    { baseX: 340, y: 40, scale: 0.75, speed: 0.008 },
    { baseX: 560, y: 95, scale: 1.3, speed: 0.006 },
    { baseX: 730, y: 55, scale: 0.9, speed: 0.01 },
  ];

  private readonly ripples = [
    { x: 110, y: 425, period: 2600, offset: 0 },
    { x: 250, y: 465, period: 3100, offset: 900 },
    { x: 400, y: 435, period: 2800, offset: 1800 },
    { x: 540, y: 500, period: 3400, offset: 400 },
    { x: 660, y: 455, period: 2900, offset: 2200 },
    { x: 320, y: 545, period: 3600, offset: 1200 },
  ];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    scoreEl: HTMLElement,
    historyEl: HTMLElement,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.scoreEl = scoreEl;
    this.historyEl = historyEl;
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.background.addEventListener("load", () => {
      this.backgroundLoaded = true;
    });
    this.background.src = "./background.jpg";
    for (let i = 0; i < SPRITE_COUNT; i++) {
      const img = new Image();
      this.spritesLoaded[i] = false;
      img.addEventListener("load", () => {
        this.spritesLoaded[i] = true;
      });
      img.src = `./sprites/squirrel-${i + 1}.png`;
      this.sprites[i] = img;
    }
    this.updateScoreText();
    this.renderHistory();
  }

  private duration(ms: number): number {
    return this.reducedMotion ? Math.min(ms, 60) : ms;
  }

  private updateScoreText(): void {
    this.scoreEl.textContent =
      this.phase === "gameover"
        ? `In the water --- score ${this.score}, best ${this.best}`
        : `Score ${this.score}`;
  }

  /** Called once per run, the moment it ends in the water --- prepends this
   *  run's score to the persisted history and re-renders the list. */
  private recordRun(): void {
    this.history.unshift(this.score);
    this.history.length = Math.min(this.history.length, MAX_HISTORY);
    saveHistory(this.history);
    this.renderHistory();
  }

  private renderHistory(): void {
    this.historyEl.replaceChildren(
      ...this.history.map((score) => {
        const li = document.createElement("li");
        li.textContent = `Score ${score}`;
        return li;
      }),
    );
  }

  /** `virtualX` is the press point in canvas (virtual) units --- present for
   *  a pointer press, absent for a keyboard (spacebar) press. Its presence
   *  picks the charge mode: a pointer press charges by drag distance in
   *  either direction (see `drag`); a keyboard press falls back to the
   *  original hold-duration charge, since there's no cursor position to
   *  drag from. */
  press(now: number, virtualX?: number): void {
    // A click on the game-over screen only restarts the run --- it shouldn't
    // also arm a charge from that same press, which read as an instant jump
    // straight into the water.
    if (this.phase === "gameover") {
      this.reset();
      return;
    }
    if (this.phase !== "ready") return;
    this.phase = "charging";
    this.chargeStart = now;
    if (virtualX === undefined) {
      this.inputMode = "hold";
    } else {
      this.inputMode = "drag";
      this.dragStartVirtualX = virtualX;
      this.dragChargeFraction = 0;
    }
  }

  /** Distance from the press point, either direction, fills the meter ---
   *  dragging left and dragging right are equally valid ways to charge. */
  drag(virtualX: number): void {
    if (this.phase !== "charging" || this.inputMode !== "drag") return;
    const dragged = Math.abs(virtualX - this.dragStartVirtualX);
    this.dragChargeFraction = Math.min(dragged / DRAG_RANGE, 1);
  }

  private chargeFraction(now: number): number {
    if (this.inputMode === "drag") return this.dragChargeFraction;
    return Math.min((now - this.chargeStart) / MAX_CHARGE_MS, 1);
  }

  release(now: number): void {
    if (this.phase !== "charging") return;
    const fraction = this.chargeFraction(now);
    this.jumpDistance = chargeToDistance(fraction * MAX_CHARGE_MS, MAX_CHARGE_MS, MAX_DISTANCE);
    this.outcome = resolveJump(this.jumpDistance, this.gap);
    this.hopFrom = this.scrollOffset;
    this.hopStart = now;
    this.phase = "airborne";
  }

  /** A held key/pointer can go silent mid-charge --- window blur, tab switch
   *  --- with no keyup/pointerup ever reaching the page. Without this the
   *  meter freezes full and a fresh press is ignored (`phase !== "ready"`),
   *  stuck until reload. Cancel back to ready instead of playing out a jump:
   *  the player didn't choose that hold, so it shouldn't cost them a life. */
  cancelCharge(): void {
    if (this.phase !== "charging") return;
    this.phase = "ready";
  }

  private reset(): void {
    this.phase = "ready";
    this.score = 0;
    this.currentStoneWorldX = 0;
    this.currentStoneWidth = START_STONE_WIDTH;
    this.gap = nextGap(0, Math.random, MAX_DISTANCE);
    this.scrollOffset = 0;
    this.updateScoreText();
  }

  update(now: number): void {
    if (this.phase === "airborne") {
      const t = Math.min((now - this.hopStart) / this.duration(JUMP_MS), 1);
      this.scrollOffset = this.hopFrom + this.jumpDistance * easeInOutQuad(t);
      if (t >= 1) {
        if (this.outcome === "stone") {
          const landedStoneWorldX = this.hopFrom + this.gap.distance;
          this.currentStoneWorldX = landedStoneWorldX;
          this.currentStoneWidth = this.gap.stoneWidth;
          this.score += 1;
          if (this.score > this.best) {
            this.best = this.score;
            saveBest(this.best);
          }
          this.gap = nextGap(this.score, Math.random, MAX_DISTANCE);
          this.settleFrom = this.scrollOffset;
          this.settleStart = now;
          this.phase = "settling";
        } else {
          this.splashStart = now;
          this.phase = "splash";
          this.recordRun();
        }
        this.updateScoreText();
      }
    } else if (this.phase === "settling") {
      const t = Math.min((now - this.settleStart) / this.duration(SETTLE_MS), 1);
      this.scrollOffset = this.settleFrom + (this.currentStoneWorldX - this.settleFrom) * easeOutCubic(t);
      if (t >= 1) this.phase = "ready";
    } else if (this.phase === "splash") {
      const t = Math.min((now - this.splashStart) / this.duration(SPLASH_MS), 1);
      if (t >= 1) {
        this.phase = "gameover";
        this.updateScoreText();
      }
    }
  }

  private worldToScreen(worldX: number): number {
    return worldX - this.scrollOffset + PLAYER_X;
  }

  render(now: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, VW, VH);

    if (this.backgroundLoaded) {
      // Cover-fit the photo into the band above the waterline: scale by
      // width (the limiting dimension for this image against this band's
      // aspect ratio) and crop the source vertically around its centre, so
      // the mountains fill the width with no letterboxing or distortion.
      const scale = VW / this.background.naturalWidth;
      const sourceHeight = WATER_Y / scale;
      const sourceY = (this.background.naturalHeight - sourceHeight) / 2;
      ctx.drawImage(this.background, 0, sourceY, this.background.naturalWidth, sourceHeight, 0, 0, VW, WATER_Y);
    } else {
      ctx.fillStyle = "#8ec3e0";
      ctx.fillRect(0, 0, VW, WATER_Y);
    }

    for (const cloud of this.clouds) {
      const x = this.reducedMotion ? cloud.baseX : ((cloud.baseX + now * cloud.speed) % (VW + 160)) - 80;
      this.drawCloud(x, cloud.y, cloud.scale);
    }

    // water --- tinted to reflect the sky above it rather than the old
    // monochrome wash.
    ctx.fillStyle = "rgba(93, 133, 158, 0.25)";
    ctx.fillRect(0, WATER_Y, VW, VH - WATER_Y);
    ctx.strokeStyle = "rgba(72, 110, 133, 0.45)";
    ctx.lineWidth = 1.5;
    const drift = (now / 900) % (2 * Math.PI);
    for (let row = 0; row < 4; row++) {
      const y = WATER_Y + 30 + row * 45;
      ctx.beginPath();
      for (let x = 0; x <= VW; x += 20) {
        const wave = Math.sin(x / 60 + drift + row) * 3;
        if (x === 0) ctx.moveTo(x, y + wave);
        else ctx.lineTo(x, y + wave);
      }
      ctx.stroke();
    }

    // ripples --- skipped under prefers-reduced-motion, since an expanding
    // ring is motion with nothing else to offer.
    if (!this.reducedMotion) {
      for (const ripple of this.ripples) {
        const phase = (((now + ripple.offset) % ripple.period) + ripple.period) % ripple.period / ripple.period;
        const radius = 6 + phase * 34;
        ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - phase) * 0.35})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(ripple.x, ripple.y, radius, radius * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // stones
    this.drawStone(this.currentStoneWorldX, this.currentStoneWidth);
    this.drawStone(this.currentStoneWorldX + this.gap.distance, this.gap.stoneWidth);

    // charge meter --- the single accent colour marks the moment of decision.
    // Sized to stay legible scaled down to the ~350px-wide mobile canvas,
    // where a smaller bar (found by playing at that viewport) read as a
    // barely-visible sliver.
    if (this.phase === "charging") {
      const t = this.chargeFraction(now);
      const barWidth = 70;
      const barHeight = 16;
      const barX = PLAYER_X - barWidth / 2;
      const barY = WATER_Y - 100;
      ctx.strokeStyle = "rgba(36, 33, 29, 0.5)";
      ctx.lineWidth = 3;
      ctx.strokeRect(barX, barY, barWidth, barHeight);
      ctx.fillStyle = "#a13f2f";
      ctx.fillRect(barX + 2, barY + 2, (barWidth - 4) * t, barHeight - 4);
    }

    // player
    this.drawPlayer(now);

    // splash
    if (this.phase === "splash") {
      const t = Math.min((now - this.splashStart) / this.duration(SPLASH_MS), 1);
      ctx.strokeStyle = `rgba(161, 63, 47, ${1 - t})`;
      ctx.lineWidth = 2;
      for (const ring of [0, 1, 2]) {
        const r = (t * 40 + ring * 10) * (1 - ring * 0.15);
        ctx.beginPath();
        ctx.ellipse(PLAYER_X, WATER_Y + 10, r, r * 0.4, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawCloud(x: number, y: number, scale: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.ellipse(x, y, 26 * scale, 13 * scale, 0, 0, Math.PI * 2);
    ctx.ellipse(x - 20 * scale, y + 5 * scale, 18 * scale, 10 * scale, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 22 * scale, y + 4 * scale, 20 * scale, 11 * scale, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 4 * scale, y - 8 * scale, 16 * scale, 9 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawStone(worldX: number, width: number): void {
    const x = this.worldToScreen(worldX);
    if (x < -width || x > VW + width) return;
    const ctx = this.ctx;
    const rx = width / 2;
    const ry = 16;
    // The classic lily-pad notch: a wedge cut from the disc, pointing
    // outward so it doesn't fall on the spot the player actually lands.
    const notchAngle = Math.PI / 2;
    const notchWidth = 0.5;

    ctx.fillStyle = "#3f6b3a";
    ctx.save();
    ctx.translate(x, WATER_Y);
    ctx.scale(rx, ry);
    ctx.beginPath();
    ctx.arc(0, 0, 1, notchAngle + notchWidth / 2, notchAngle - notchWidth / 2 + Math.PI * 2);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "rgba(36, 58, 30, 0.5)";
    ctx.lineWidth = 1;
    for (const a of [-0.9, -0.3, 0.3, 0.9]) {
      ctx.beginPath();
      ctx.moveTo(x, WATER_Y);
      ctx.lineTo(x + Math.cos(a) * rx * 0.85, WATER_Y + Math.sin(a) * ry * 0.85);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.beginPath();
    ctx.ellipse(x - width / 6, WATER_Y - 5, width / 5, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayer(now: number): void {
    const ctx = this.ctx;
    let y = WATER_Y - 20;
    let frameIndex = IDLE_FRAME;

    if (this.phase === "airborne") {
      const t = Math.min((now - this.hopStart) / this.duration(JUMP_MS), 1);
      y -= Math.sin(Math.PI * t) * 70;
      frameIndex = JUMP_FRAME;
    } else if (this.phase === "splash") {
      const t = Math.min((now - this.splashStart) / this.duration(SPLASH_MS), 1);
      y = WATER_Y - 20 + t * 26;
      ctx.globalAlpha = Math.max(1 - t * 1.3, 0);
      frameIndex = JUMP_FRAME;
    } else if (this.phase === "gameover") {
      return;
    }

    // The camera always recentres on the player's own trajectory (see
    // worldToScreen), so the player is drawn at a fixed screen x in every
    // phase --- it's the stones that visibly slide short or long of it.
    const sprite = this.sprites[frameIndex - 1];
    if (sprite && this.spritesLoaded[frameIndex - 1]) {
      const drawHeight = 56;
      const drawWidth = drawHeight * (sprite.naturalWidth / sprite.naturalHeight);
      ctx.drawImage(sprite, PLAYER_X - drawWidth / 2, y + 14 - drawHeight, drawWidth, drawHeight);
    } else {
      ctx.fillStyle = "#24211d";
      ctx.beginPath();
      ctx.ellipse(PLAYER_X, y, 12, 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function main(): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#stage");
  const scoreEl = document.querySelector<HTMLElement>("#score");
  const historyEl = document.querySelector<HTMLElement>("#history-list");
  if (!canvas || !scoreEl || !historyEl) return;

  const game = new FarBank(canvas, scoreEl, historyEl);

  function resize(): void {
    const rect = canvas!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas!.width = Math.max(1, Math.round(rect.width * dpr));
    canvas!.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas!.getContext("2d");
    if (!ctx) return;
    const scale = Math.min(canvas!.width / VW, canvas!.height / VH);
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      (canvas!.width - VW * scale) / 2,
      (canvas!.height - VH * scale) / 2,
    );
  }

  new ResizeObserver(resize).observe(canvas);
  resize();

  /** `ResizeObserver` only fires on a CSS box-size change --- dragging the
   *  window to a different-DPI display, or an OS/browser zoom that doesn't
   *  reflow layout, changes `devicePixelRatio` with the canvas's CSS size
   *  untouched, leaving the backing store at the stale resolution. A
   *  `resolution` media query re-armed after each match is the standard way
   *  to catch that case too. */
  function watchDevicePixelRatio(): void {
    const mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mql.addEventListener(
      "change",
      () => {
        resize();
        watchDevicePixelRatio();
      },
      { once: true },
    );
  }
  watchDevicePixelRatio();

  let activePointerId: number | null = null;

  /** Converts a client-space pointer coordinate to the same virtual x-axis
   *  the game logic works in --- the canvas's CSS box scales uniformly with
   *  its 4:3 backing store (see styles.css), so a plain width ratio is
   *  enough; no need to account for devicePixelRatio or letterboxing. */
  function virtualXFromEvent(event: PointerEvent): number {
    const rect = canvas!.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * VW;
  }

  /** A right-click's `contextmenu` reliably reaches the page, but whether the
   *  native menu it opens fires `blur` first is inconsistent across browsers
   *  and platforms --- so the existing blur-cancels-a-stuck-charge safety net
   *  can't be trusted to recover a charge a right-click started. Simplest fix
   *  is to never start one: only the primary button (mouse) or a touch/pen
   *  contact (`button === 0` for both) presses, and the menu itself is
   *  suppressed since it has nothing relevant to offer over the canvas. */
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener("pointerdown", (event) => {
    if (activePointerId !== null || event.button !== 0) return;
    activePointerId = event.pointerId;
    event.preventDefault();
    game.press(performance.now(), virtualXFromEvent(event));
  });
  window.addEventListener("pointermove", (event) => {
    if (event.pointerId !== activePointerId) return;
    game.drag(virtualXFromEvent(event));
  });
  const endPointer = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    game.release(performance.now());
  };
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  window.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.code !== "Space") return;
    event.preventDefault();
    if (event.repeat) return;
    game.press(performance.now());
  });
  window.addEventListener("keyup", (event) => {
    if (event.key !== " " && event.code !== "Space") return;
    event.preventDefault();
    game.release(performance.now());
  });

  const cancelStuckCharge = (): void => {
    activePointerId = null;
    game.cancelCharge();
  };
  window.addEventListener("blur", cancelStuckCharge);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelStuckCharge();
  });

  function frame(now: number): void {
    game.update(now);
    game.render(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
