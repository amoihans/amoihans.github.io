/**
 * 看板娘：把 Live2D 模型渲染到 PIXI 画布上，处理
 *   - 鼠标跟踪（眼珠/头/身体）
 *   - 点击 → 播放 TapBody 动作
 *   - 空闲 N 秒 → 随机动作
 *   - 显隐（持久化到 localStorage）
 *   - 拖拽（fixed 容器）
 *   - 移动端 / reduced-motion 自动隐藏
 *
 * 参考：D:\hans\live2d\kanban-live2d\src\components\Live2DKanban.tsx
 */
import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import * as PIXI from "pixi.js";
// v0.5-beta 拆分了入口：cubism4 子路径才有 Live2DModel 类
import { Live2DModel } from "pixi-live2d-display/cubism4";

// 让 pixi-live2d-display 在模块内部能拿到 PIXI（v0.5 要求）
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

// 让 PIXI 接管时把 live2d 模型注册到 PIXI 的 ticker（v0.5 接受 ticker 类本身）。
Live2DModel.registerTicker(PIXI.Ticker);

export type Live2DKanbanHandle = {
  playRandomMotion: () => Promise<void>;
  playTapMotion: () => Promise<void>;
  setVisible: (v: boolean) => void;
  getVisible: () => boolean;
};

export type Live2DKanbanProps = {
  /** `.model3.json` 的 URL（已处理过 BASE_URL） */
  modelPath: string;
  /** 画布宽 */
  width?: number;
  /** 画布高 */
  height?: number;
  /** 模型在画布中的缩放（0~N，1 = contain） */
  scale?: number;
  /** 留白比例 0~1（contain 时生效） */
  fitMargin?: number;
  /** 鼠标多久没动就触发 idle 随机动作（毫秒），0 表示关闭 */
  idleRandomAfterMs?: number;
  /** 是否可拖拽 */
  draggable?: boolean;
  /** 鼠标跟踪强度 0~1 */
  followStrength?: number;
  /** 初始位置锚点 */
  anchor?: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  /** localStorage key：保存「用户已隐藏」状态；不传则不持久化 */
  hiddenStorageKey?: string;
  /** 移动端断点（默认 768px） */
  mobileBreakpointPx?: number;
};

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 600;

export const Live2DKanban = forwardRef<Live2DKanbanHandle, Live2DKanbanProps>(
  function Live2DKanban(props, ref) {
    const {
      modelPath,
      width = DEFAULT_WIDTH,
      height = DEFAULT_HEIGHT,
      scale: legacyScale = 1,
      fitMargin = 0.95,
      idleRandomAfterMs = 8000,
      draggable = true,
      followStrength = 1,
      anchor = "bottom-right",
      hiddenStorageKey,
      mobileBreakpointPx = 768,
    } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const appRef = useRef<PIXI.Application | null>(null);
    const modelRef = useRef<Live2DModel | null>(null);
    const lastInteractionRef = useRef<number>(performance.now());
    const randomTimerRef = useRef<number | null>(null);
    const applyFollowRef = useRef<((nx: number, ny: number) => void) | null>(
      null
    );
    const coreModelRef = useRef<unknown>(null);
    const hiddenByUserRef = useRef<boolean>(false);

    // 读取 localStorage 中的「用户隐藏」状态
    useEffect(() => {
      if (!hiddenStorageKey) return;
      try {
        hiddenByUserRef.current =
          localStorage.getItem(hiddenStorageKey) === "1";
      } catch {
        // 忽略隐私模式等异常
      }
    }, [hiddenStorageKey]);

    // 移动端 / reduced-motion 直接不渲染
    const [shouldRender, setShouldRender] = useState<boolean>(() => {
      if (typeof window === "undefined") return true;
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      if (reducedMotion) return false;
      return window.innerWidth >= mobileBreakpointPx;
    });

    useEffect(() => {
      if (typeof window === "undefined") return;
      const mql = window.matchMedia(`(min-width: ${mobileBreakpointPx}px)`);
      const reducedMql = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      );
      const update = () => {
        const reduced = reducedMql.matches;
        const wide = mql.matches;
        setShouldRender(!reduced && wide);
      };
      mql.addEventListener("change", update);
      reducedMql.addEventListener("change", update);
      return () => {
        mql.removeEventListener("change", update);
        reducedMql.removeEventListener("change", update);
      };
    }, [mobileBreakpointPx]);

    const [visible, setVisible] = useState<boolean>(true);
    const [status, setStatus] = useState<"loading" | "ready" | "error">(
      "loading"
    );
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [pos, setPos] = useState<{ x: number; y: number }>(() => {
      if (typeof window === "undefined") return { x: 0, y: 0 };
      const x = anchor.includes("right")
        ? window.innerWidth - width - 24
        : 24;
      const y = anchor.includes("bottom")
        ? window.innerHeight - height - 24
        : 24;
      return { x, y };
    });

    // 命令式 API
    useImperativeHandle(
      ref,
      () => ({
        playRandomMotion: async () => {
          const m = modelRef.current;
          if (!m) return;
          const group = pickRandomGroup(m);
          if (!group) return;
          await m.motion(group.name, Math.floor(Math.random() * group.count));
        },
        playTapMotion: async () => {
          const m = modelRef.current;
          if (!m) return;
          const def = (m.internalModel as { settings?: { motions?: Record<string, unknown[]> } })
            ?.settings?.motions?.TapBody;
          if (Array.isArray(def) && def.length) {
            await m.motion("TapBody", Math.floor(Math.random() * def.length));
          } else {
            await m.motion("Idle", Math.floor(Math.random() * 3));
          }
        },
        setVisible: (v: boolean) => {
          setVisible(v);
          if (!v && hiddenStorageKey) {
            hiddenByUserRef.current = true;
            try {
              localStorage.setItem(hiddenStorageKey, "1");
            } catch {
              /* ignore */
            }
          } else if (v && hiddenStorageKey) {
            hiddenByUserRef.current = false;
            try {
              localStorage.removeItem(hiddenStorageKey);
            } catch {
              /* ignore */
            }
          }
        },
        getVisible: () => visible,
      }),
      [visible, hiddenStorageKey]
    );

    // PIXI + 加载模型
    useEffect(() => {
      if (!containerRef.current) return;
      let disposed = false;

      const app = new PIXI.Application({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      appRef.current = app;
      containerRef.current.appendChild(app.view as HTMLCanvasElement);

      (async () => {
        try {
          const model = await Live2DModel.from(modelPath, {
            autoInteract: false,
          });
          if (disposed) {
            model.destroy();
            return;
          }
          modelRef.current = model;

          const internal = model.internalModel as {
            originalWidth?: number;
            originalHeight?: number;
            coreModel?: unknown;
          };
          let naturalW: number =
            internal.originalWidth || (model as unknown as { width?: number }).width || 0;
          let naturalH: number =
            internal.originalHeight ||
            (model as unknown as { height?: number }).height ||
            0;
          if (!naturalW || !naturalH) {
            naturalW = naturalW || 2048;
            naturalH = naturalH || 2048;
          }
          const margin = Math.max(0.01, Math.min(1, fitMargin));
          const fitScale = Math.min(
            (width * margin) / naturalW,
            (height * margin) / naturalH
          );
          const finalScale = fitScale * legacyScale;
          model.anchor.set(0.5, 0.5);
          model.position.set(width / 2, height / 2);
          model.scale.set(finalScale);

          app.stage.addChild(model);
          app.stage.eventMode = "static";
          app.stage.hitArea = new PIXI.Rectangle(0, 0, width, height);

          // 鼠标跟踪
          const coreModel = internal.coreModel as {
            setParameterValueById: (id: string, value: number) => void;
          };
          coreModelRef.current = coreModel;

          const applyFollow = (nx: number, ny: number) => {
            const k = followStrength;
            const stageCenterX = width / 2;
            const stageCenterY = height / 2;
            const R = 2000;
            const worldX = stageCenterX + nx * R * k;
            const worldY = stageCenterY + ny * R * k;
            (model as unknown as { focus?: (x: number, y: number, rel?: boolean) => void }).focus?.(
              worldX,
              worldY,
              true
            );
          };
          applyFollowRef.current = applyFollow;
          applyFollow(0, 0);

          // 全局鼠标跟踪：用视口坐标，与画布位置无关
          const onPointerMove = (e: PointerEvent) => {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const nx = (e.clientX - vw / 2) / (vw / 2);
            const ny = (e.clientY - vh / 2) / (vh / 2);
            applyFollow(clamp(nx, -1, 1), clamp(ny, -1, 1));
            lastInteractionRef.current = performance.now();
          };
          window.addEventListener("pointermove", onPointerMove, true);

          // 点击触发
          const onTap = () => {
            const settings = (
              model.internalModel as {
                settings?: { motions?: Record<string, unknown[]> };
              }
            ).settings;
            const hasTap = settings?.motions?.TapBody?.length;
            if (hasTap) {
              const idx = Math.floor(Math.random() * hasTap);
              model.motion("TapBody", idx);
            } else {
              const group = pickRandomGroup(model);
              if (group)
                model.motion(
                  group.name,
                  Math.floor(Math.random() * group.count)
                );
            }
            lastInteractionRef.current = performance.now();
          };
          model.on("hit", onTap);

          setStatus("ready");

          // 空闲随机
          if (idleRandomAfterMs > 0) {
            const tick = () => {
              if (disposed) return;
              const now = performance.now();
              if (now - lastInteractionRef.current >= idleRandomAfterMs) {
                const group = pickRandomGroup(model);
                if (group) {
                  model.motion(
                    group.name,
                    Math.floor(Math.random() * group.count)
                  );
                }
                lastInteractionRef.current = now;
              }
              randomTimerRef.current = window.setTimeout(tick, 1000);
            };
            randomTimerRef.current = window.setTimeout(tick, 1000);
          }

          (model as unknown as { _cleanup?: () => void })._cleanup = () => {
            window.removeEventListener("pointermove", onPointerMove, true);
            (model as unknown as { off?: (e: string, fn: () => void) => void }).off?.(
              "hit",
              onTap
            );
          };
        } catch (err) {
          console.error("[Live2D] load failed:", err);
          if (!disposed) {
            setStatus("error");
            setErrorMsg(err instanceof Error ? err.message : String(err));
          }
        }
      })();

      return () => {
        disposed = true;
        if (randomTimerRef.current != null) {
          clearTimeout(randomTimerRef.current);
          randomTimerRef.current = null;
        }
        const m = modelRef.current;
        if (m) {
          (m as unknown as { _cleanup?: () => void })._cleanup?.();
          m.destroy();
          modelRef.current = null;
        }
        applyFollowRef.current = null;
        coreModelRef.current = null;
        if (appRef.current) {
          appRef.current.destroy(true, {
            children: true,
            texture: true,
            baseTexture: true,
          });
          appRef.current = null;
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelPath, width, height, legacyScale, fitMargin, idleRandomAfterMs, followStrength]);

    // 拖拽
    useEffect(() => {
      if (!draggable) return;
      const el = containerRef.current;
      if (!el) return;
      let dragging = false;
      let offsetX = 0;
      let offsetY = 0;

      const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        dragging = true;
        el.setPointerCapture(e.pointerId);
        offsetX = e.clientX - el.offsetLeft;
        offsetY = e.clientY - el.offsetTop;
        el.style.cursor = "grabbing";
        e.stopPropagation();
      };
      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        const x = e.clientX - offsetX;
        const y = e.clientY - offsetY;
        const maxX = window.innerWidth - el.offsetWidth;
        const maxY = window.innerHeight - el.offsetHeight;
        setPos({
          x: Math.max(0, Math.min(maxX, x)),
          y: Math.max(0, Math.min(maxY, y)),
        });
      };
      const onUp = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        el.releasePointerCapture(e.pointerId);
        el.style.cursor = "grab";
      };
      el.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return () => {
        el.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
    }, [draggable]);

    // 如果用户曾在别的页面隐藏过看板娘，恢复隐藏状态
    useEffect(() => {
      if (hiddenByUserRef.current) setVisible(false);
    }, []);

    if (!shouldRender) return null;

    return (
      <div
        ref={containerRef}
        style={{
          position: "fixed",
          left: pos.x,
          top: pos.y,
          width,
          height,
          zIndex: 9999,
          cursor: draggable ? "grab" : "default",
          display: visible ? "block" : "none",
          touchAction: "none",
          userSelect: "none",
        }}
        title="拖拽移动 · 点击模型触发动作"
      >
        {status !== "ready" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 13,
              textShadow: "0 1px 2px rgba(0,0,0,.5)",
              pointerEvents: "none",
            }}
          >
            {status === "loading" ? "Loading…" : `Load failed: ${errorMsg}`}
          </div>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setVisible((v) => {
              const next = !v;
              if (!next && hiddenStorageKey) {
                hiddenByUserRef.current = true;
                try {
                  localStorage.setItem(hiddenStorageKey, "1");
                } catch {
                  /* ignore */
                }
              } else if (next && hiddenStorageKey) {
                hiddenByUserRef.current = false;
                try {
                  localStorage.removeItem(hiddenStorageKey);
                } catch {
                  /* ignore */
                }
              }
              return next;
            });
          }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 24,
            height: 24,
            border: "none",
            borderRadius: 12,
            background: "rgba(0,0,0,.45)",
            color: "#fff",
            fontSize: 14,
            lineHeight: "24px",
            cursor: "pointer",
            zIndex: 2,
          }}
          aria-label={visible ? "隐藏看板娘" : "显示看板娘"}
          title={visible ? "隐藏看板娘" : "显示看板娘"}
        >
          {visible ? "−" : "+"}
        </button>
      </div>
    );
  }
);

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

type MotionGroupInfo = { name: string; count: number };
function pickRandomGroup(m: Live2DModel): MotionGroupInfo | null {
  const settings = (
    m.internalModel as { settings?: { motions?: Record<string, unknown[]> } }
  ).settings;
  const motions = settings?.motions;
  if (!motions) return null;
  const names = Object.keys(motions).filter(
    (n) => Array.isArray(motions[n]) && motions[n].length > 0
  );
  if (!names.length) return null;
  // 偏向 Idle 分组
  const idle = names.find((n) => /idle/i.test(n));
  const choice = idle ?? names[Math.floor(Math.random() * names.length)];
  return { name: choice, count: (motions[choice] as unknown[]).length };
}
