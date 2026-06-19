import { ChangeEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brush,
  CircleIcon,
  Eye,
  EyeOff,
  ImagePlus,
  Lock,
  MousePointer2,
  PaintBucket,
  Plus,
  Shapes,
  Slash,
  Square,
  Trash2,
  Type,
} from "lucide-react";
import {
  Canvas,
  Circle,
  FabricImage,
  FabricObject,
  Line,
  PencilBrush,
  Point,
  Rect,
  Textbox,
} from "fabric";

type LayerRole = "edit" | "base";
type Tool = "select" | "image" | "text" | "rect" | "circle" | "line" | "pen" | "bucket";
type BrushKind = "normal" | "pressure";

type EditorLayer = {
  id: string;
  name: string;
  role: LayerRole;
  visible: boolean;
};

type LayeredObject = FabricObject & {
  layerId?: string;
  role?: LayerRole;
  objectKind?: string;
};

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 640;
const BASE_LAYER_ID = "base-layer";
const LOWER_LAYER_ID = "lower-layer";
const UPPER_LAYER_ID = "upper-layer";

const INITIAL_LAYERS: EditorLayer[] = [
  { id: UPPER_LAYER_ID, name: "上側編集レイヤー", role: "edit", visible: true },
  { id: BASE_LAYER_ID, name: "ベースレイヤー", role: "base", visible: true },
  { id: LOWER_LAYER_ID, name: "下側編集レイヤー", role: "edit", visible: true },
];

const FONT_OPTIONS = [
  "sans-serif",
  "serif",
  "monospace",
  "Yu Gothic",
  "Meiryo",
  "Noto Sans JP",
];

type IconButtonProps = {
  active?: boolean;
  children: ReactNode;
  label: string;
  onClick: () => void;
  tone?: "default" | "primary";
};

function IconButton({ active = false, children, label, onClick, tone = "default" }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={`icon-button ${active ? "is-active" : ""} ${tone === "primary" ? "is-primary" : ""}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function isLayeredObject(object: FabricObject): object is LayeredObject {
  return "layerId" in object || "role" in object;
}

function makeObjectSelectable(object: LayeredObject, selectable: boolean) {
  object.set({
    selectable,
    evented: selectable,
    lockMovementX: !selectable,
    lockMovementY: !selectable,
    lockScalingX: !selectable,
    lockScalingY: !selectable,
    lockRotation: !selectable,
    hasControls: selectable,
    hasBorders: selectable,
  });
}

function getLayerIndex(layers: EditorLayer[], layerId: string) {
  const index = layers.findIndex((layer) => layer.id === layerId);
  return index === -1 ? layers.length : index;
}

function fitTextToBox(textbox: Textbox) {
  const minSize = 8;
  const maxSize = 96;
  const width = textbox.width || 160;
  const height = textbox.height || 48;
  const textLength = Math.max(textbox.text?.length || 1, 1);
  const byWidth = Math.floor((width / textLength) * 1.8);
  const byHeight = Math.floor(height * 0.72);
  const nextSize = Math.max(minSize, Math.min(maxSize, byWidth, byHeight));
  textbox.set({ fontSize: nextSize });
}

function layerLabel(layer: EditorLayer) {
  return layer.role === "base" ? `${layer.name} 固定` : layer.name;
}

function hexToRgba(hex: string) {
  const value = hex.replace("#", "");
  const normalized =
    value.length === 3
      ? value
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : value;
  const number = Number.parseInt(normalized, 16);
  return {
    r: (number >> 16) & 255,
    g: (number >> 8) & 255,
    b: number & 255,
    a: 255,
  };
}

function isSameColor(data: Uint8ClampedArray, index: number, target: ReturnType<typeof hexToRgba>) {
  return (
    data[index] === target.r &&
    data[index + 1] === target.g &&
    data[index + 2] === target.b &&
    data[index + 3] === target.a
  );
}

function floodFillMask(
  source: ImageData,
  startX: number,
  startY: number,
  fillColor: ReturnType<typeof hexToRgba>,
) {
  const { width, height, data } = source;
  const startIndex = (startY * width + startX) * 4;
  const target = {
    r: data[startIndex],
    g: data[startIndex + 1],
    b: data[startIndex + 2],
    a: data[startIndex + 3],
  };
  const output = new ImageData(width, height);

  if (isSameColor(data, startIndex, fillColor)) {
    return output;
  }

  const visited = new Uint8Array(width * height);
  const stack: Array<[number, number]> = [[startX, startY]];

  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number];
    if (x < 0 || y < 0 || x >= width || y >= height) {
      continue;
    }
    const pixel = y * width + x;
    if (visited[pixel]) {
      continue;
    }
    visited[pixel] = 1;

    const index = pixel * 4;
    if (!isSameColor(data, index, target)) {
      continue;
    }

    output.data[index] = fillColor.r;
    output.data[index + 1] = fillColor.g;
    output.data[index + 2] = fillColor.b;
    output.data[index + 3] = fillColor.a;

    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  return output;
}

export default function App() {
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const canvasPanelRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const baseInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const lineStartRef = useRef<Point | null>(null);
  const layerIdCounterRef = useRef(1);

  const [layers, setLayers] = useState<EditorLayer[]>(INITIAL_LAYERS);
  const [activeLayerId, setActiveLayerId] = useState(UPPER_LAYER_ID);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#ef4444");
  const [fillColor, setFillColor] = useState("#facc15");
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [fontFamily, setFontFamily] = useState(FONT_OPTIONS[0]);
  const [brushKind, setBrushKind] = useState<BrushKind>("normal");
  const [mobilePanel, setMobilePanel] = useState<"canvas" | "layers" | "props">("canvas");
  const [selectedObject, setSelectedObject] = useState<LayeredObject | null>(null);
  const [message, setMessage] = useState("ベース画像を読み込んで編集を開始します。");

  const centerCanvasInPanel = useCallback(() => {
    const panel = canvasPanelRef.current;
    if (!panel) {
      return;
    }
    panel.scrollLeft = Math.max(0, (panel.scrollWidth - panel.clientWidth) / 2);
    panel.scrollTop = Math.max(0, (panel.scrollHeight - panel.clientHeight) / 2);
  }, []);

  const activeLayer = useMemo(
    () => layers.find((layer) => layer.id === activeLayerId),
    [activeLayerId, layers],
  );

  const reorderCanvasObjects = useCallback(
    (canvas: Canvas, nextLayers = layers) => {
      const objects = canvas.getObjects() as LayeredObject[];
      objects.sort((a, b) => {
        const aIndex = getLayerIndex(nextLayers, a.layerId || "");
        const bIndex = getLayerIndex(nextLayers, b.layerId || "");
        return bIndex - aIndex;
      });
      objects.forEach((object) => canvas.bringObjectToFront(object));
      canvas.requestRenderAll();
    },
    [layers],
  );

  const syncLayerVisibility = useCallback(
    (nextLayers = layers) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const visibility = new Map(nextLayers.map((layer) => [layer.id, layer.visible]));
      canvas.getObjects().forEach((object) => {
        if (!isLayeredObject(object)) {
          return;
        }
        object.set({ visible: visibility.get(object.layerId || "") ?? true });
      });
      reorderCanvasObjects(canvas, nextLayers);
    },
    [layers, reorderCanvasObjects],
  );

  const addObjectToActiveLayer = useCallback(
    (object: LayeredObject) => {
      const canvas = canvasRef.current;
      if (!canvas || !activeLayer || activeLayer.role !== "edit") {
        setMessage("編集レイヤーを選択してください。");
        return;
      }
      object.layerId = activeLayer.id;
      object.role = "edit";
      object.set({ visible: activeLayer.visible });
      makeObjectSelectable(object, true);
      canvas.add(object);
      canvas.setActiveObject(object);
      reorderCanvasObjects(canvas);
      setSelectedObject(object);
    },
    [activeLayer, reorderCanvasObjects],
  );

  useEffect(() => {
    const element = canvasElementRef.current;
    if (!element) {
      return;
    }

    const canvas = new Canvas(element, {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      backgroundColor: "#ffffff",
      preserveObjectStacking: true,
      selection: true,
    });
    canvasRef.current = canvas;

    canvas.on("selection:created", (event) => {
      setSelectedObject((event.selected?.[0] as LayeredObject | undefined) || null);
    });
    canvas.on("selection:updated", (event) => {
      setSelectedObject((event.selected?.[0] as LayeredObject | undefined) || null);
    });
    canvas.on("selection:cleared", () => {
      setSelectedObject(null);
    });
    canvas.on("object:scaling", (event) => {
      const target = event.target as Textbox | undefined;
      if (target?.type === "textbox") {
        const scaledWidth = (target.width || 160) * (target.scaleX || 1);
        const scaledHeight = (target.height || 48) * (target.scaleY || 1);
        target.set({ width: scaledWidth, height: scaledHeight, scaleX: 1, scaleY: 1 });
        fitTextToBox(target);
        target.setCoords();
      }
    });
    canvas.on("text:changed", (event) => {
      const target = event.target as Textbox | undefined;
      if (target?.type === "textbox") {
        fitTextToBox(target);
        canvas.requestRenderAll();
      }
    });

    return () => {
      canvas.dispose();
      canvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const panel = canvasPanelRef.current;
    const canvasElement = canvasElementRef.current;
    if (!canvas) {
      return;
    }
    const cursor = tool === "text" ? "text" : tool === "bucket" ? "crosshair" : "default";

    canvas.isDrawingMode = tool === "pen";
    canvas.selection = tool === "select";
    canvas.defaultCursor = tool === "text" ? "text" : tool === "bucket" ? "crosshair" : "default";
    canvas.hoverCursor = tool === "text" ? "text" : "move";
    canvas.moveCursor = tool === "text" ? "text" : "move";
    canvas.getObjects().forEach((object) => {
      if (!isLayeredObject(object)) {
        return;
      }
      makeObjectSelectable(object, tool === "select" && object.role !== "base");
    });

    if (panel) {
      panel.style.cursor = cursor;
    }
    if (canvasElement) {
      canvasElement.style.cursor = cursor;
    }

    if (tool === "pen") {
      const brush = new PencilBrush(canvas);
      brush.color = color;
      brush.width = brushKind === "pressure" ? strokeWidth + 6 : strokeWidth;
      canvas.freeDrawingBrush = brush;
    }

    canvas.requestRenderAll();
  }, [tool, color, strokeWidth, brushKind]);

  useEffect(() => {
    syncLayerVisibility(layers);
  }, [layers, syncLayerVisibility]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const object = selectedObject;
    if (!canvas || !object || object.role === "base") {
      return;
    }
    if (object.type === "textbox") {
      object.set({ fill: color, fontFamily });
      fitTextToBox(object as Textbox);
    }
    if (object.type === "path" || object.type === "line") {
      object.set({ stroke: color, strokeWidth });
    }
    if (object.type === "rect" || object.type === "circle") {
      object.set({ fill: fillColor, stroke: color, strokeWidth });
    }
    canvas.requestRenderAll();
  }, [color, fillColor, fontFamily, selectedObject, strokeWidth]);

  const readImageFile = (file: File, callback: (image: HTMLImageElement) => void) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => callback(image);
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleBaseImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const canvas = canvasRef.current;
    if (!file || !canvas) {
      return;
    }

    readImageFile(file, (image) => {
      canvas.getObjects().forEach((object) => {
        if (isLayeredObject(object) && object.role === "base") {
          canvas.remove(object);
        }
      });
      canvas.setDimensions({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      const fabricImage = new FabricImage(image) as LayeredObject;
      fabricImage.set({
        left: image.naturalWidth / 2,
        top: image.naturalHeight / 2,
        originX: "center",
        originY: "center",
        scaleX: 1,
        scaleY: 1,
      });
      fabricImage.layerId = BASE_LAYER_ID;
      fabricImage.role = "base";
      fabricImage.objectKind = "base-image";
      makeObjectSelectable(fabricImage, false);
      canvas.add(fabricImage);
      reorderCanvasObjects(canvas);
      setMessage(`ベース画像を読み込みました。キャンバスサイズ: ${image.naturalWidth} x ${image.naturalHeight}`);
      requestAnimationFrame(() => {
        centerCanvasInPanel();
        requestAnimationFrame(centerCanvasInPanel);
      });
    });
    event.target.value = "";
  };

  const handleAddImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    readImageFile(file, (image) => {
      const fabricImage = new FabricImage(image) as LayeredObject;
      const scale = Math.min(260 / image.width, 220 / image.height, 1);
      fabricImage.set({
        left: 160,
        top: 120,
        scaleX: scale,
        scaleY: scale,
      });
      addObjectToActiveLayer(fabricImage);
    });
    event.target.value = "";
  };

  const addTextboxAt = (x: number, y: number) => {
    const textbox = new Textbox("テキスト", {
      left: x,
      top: y,
      width: 220,
      height: 64,
      fill: color,
      fontFamily,
      fontSize: 32,
      editable: true,
    }) as LayeredObject;
    textbox.objectKind = "text";
    addObjectToActiveLayer(textbox);

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.setActiveObject(textbox);
    canvas.requestRenderAll();
    textbox.enterEditing?.();
  };

  const addRectangle = () => {
    addObjectToActiveLayer(
      new Rect({
        left: 180,
        top: 160,
        width: 180,
        height: 110,
        fill: fillColor,
        stroke: color,
        strokeWidth,
      }) as LayeredObject,
    );
  };

  const addCircle = () => {
    addObjectToActiveLayer(
      new Circle({
        left: 200,
        top: 160,
        radius: 70,
        fill: fillColor,
        stroke: color,
        strokeWidth,
      }) as LayeredObject,
    );
  };

  const startLineTool = () => {
    setTool("line");
    setMessage("キャンバス上で始点と終点を順にクリックします。");
  };

  const addLayer = () => {
    const id = `edit-layer-${layerIdCounterRef.current}`;
    layerIdCounterRef.current += 1;
    const layer: EditorLayer = {
      id,
      name: `編集レイヤー ${layerIdCounterRef.current}`,
      role: "edit",
      visible: true,
    };
    setLayers((current) => {
      const baseIndex = current.findIndex((item) => item.id === BASE_LAYER_ID);
      const next = [...current];
      next.splice(Math.max(baseIndex, 0), 0, layer);
      return next;
    });
    setActiveLayerId(id);
  };

  const moveLayer = (layerId: string, direction: -1 | 1) => {
    setLayers((current) => {
      const index = current.findIndex((layer) => layer.id === layerId);
      const targetIndex = index + direction;
      if (index === -1 || targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }
      if (current[index].role === "base" || current[targetIndex].role === "base") {
        return current;
      }
      const next = [...current];
      const [layer] = next.splice(index, 1);
      next.splice(targetIndex, 0, layer);
      const canvas = canvasRef.current;
      if (canvas) {
        reorderCanvasObjects(canvas, next);
      }
      return next;
    });
  };

  const toggleLayerVisibility = (layerId: string) => {
    setLayers((current) =>
      current.map((layer) =>
        layer.id === layerId ? { ...layer, visible: !layer.visible } : layer,
      ),
    );
  };

  const deleteSelectedObject = () => {
    const canvas = canvasRef.current;
    const object = canvas?.getActiveObject() as LayeredObject | undefined;
    if (!canvas || !object || object.role === "base") {
      return;
    }
    canvas.remove(object);
    canvas.discardActiveObject();
    setSelectedObject(null);
    canvas.requestRenderAll();
  };

  const fillBucketAt = (x: number, y: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !activeLayer || activeLayer.role !== "edit") {
      setMessage("編集レイヤーを選択してください。");
      return;
    }

    const objects = canvas.getObjects() as LayeredObject[];
    const visibility = objects.map((object) => object.visible);
    const backgroundColor = canvas.backgroundColor;
    canvas.discardActiveObject();
    canvas.set({ backgroundColor: "" });
    objects.forEach((object) => {
      object.set({ visible: object.layerId === activeLayer.id });
    });
    canvas.renderAll();

    const snapshot = canvas.toCanvasElement(1);
    objects.forEach((object, index) => {
      object.set({ visible: visibility[index] });
    });
    canvas.set({ backgroundColor });
    canvas.renderAll();

    const context = snapshot.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return;
    }

    const startX = Math.max(0, Math.min(snapshot.width - 1, Math.floor(x)));
    const startY = Math.max(0, Math.min(snapshot.height - 1, Math.floor(y)));
    const source = context.getImageData(0, 0, snapshot.width, snapshot.height);
    const output = floodFillMask(source, startX, startY, hexToRgba(fillColor));
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = snapshot.width;
    outputCanvas.height = snapshot.height;
    outputCanvas.getContext("2d")?.putImageData(output, 0, 0);

    const fill = new FabricImage(outputCanvas, {
      left: 0,
      top: 0,
    }) as LayeredObject;
    fill.objectKind = "bucket-fill";
    addObjectToActiveLayer(fill);
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getElement().getBoundingClientRect();
    const point = new Point(event.clientX - rect.left, event.clientY - rect.top);

    if (tool === "line") {
      if (!lineStartRef.current) {
        lineStartRef.current = point;
        return;
      }
      const line = new Line(
        [lineStartRef.current.x, lineStartRef.current.y, point.x, point.y],
        {
          stroke: color,
          strokeWidth,
          strokeLineCap: "round",
          strokeLineJoin: "round",
        },
      ) as LayeredObject;
      line.objectKind = "line";
      addObjectToActiveLayer(line);
      lineStartRef.current = null;
      setTool("select");
    }

    if (tool === "bucket") {
      fillBucketAt(point.x, point.y);
    }
  };

  const handleCanvasDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getElement().getBoundingClientRect();
    const point = new Point(event.clientX - rect.left, event.clientY - rect.top);

    if (tool === "text") {
      addTextboxAt(point.x, point.y);
      return;
    }
  };

  const exportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    const dataUrl = canvas.toDataURL({
      format: "png",
      multiplier: 1,
    });
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = "gazou-editor.png";
    link.click();
  };

  const setToolAndMessage = (nextTool: Tool) => {
    setTool(nextTool);
    lineStartRef.current = null;
    if (nextTool === "pen") {
      setMessage("ドラッグまたはタッチで線を描きます。");
    } else if (nextTool === "bucket") {
      setMessage("塗りつぶしたい場所をクリックします。");
    } else if (nextTool === "text") {
      setMessage("キャンバスをダブルクリックしてテキストを追加します。");
    } else {
      setMessage("オブジェクトを選択して編集します。");
    }
  };

  const toolPanel = () => (
    <aside className="tool-rail" aria-label="ツール">
      <input
        ref={baseInputRef}
        accept="image/*"
        className="file-input"
        onChange={handleBaseImage}
        type="file"
      />
      <input
        ref={imageInputRef}
        accept="image/*"
        className="file-input"
        onChange={handleAddImage}
        type="file"
      />
      <button
        className="primary-button full-width compact-text"
        onClick={exportPng}
        title="出力"
        type="button"
      >
        出力
      </button>

      <div className="tool-group">
        <IconButton label="開く" onClick={() => baseInputRef.current?.click()} tone="primary">
          <span className="compact-text">開く</span>
        </IconButton>
        <div className="tool-separator" />
        <IconButton active={tool === "select"} label="選択" onClick={() => setToolAndMessage("select")}>
          <MousePointer2 size={17} />
        </IconButton>
      </div>

      <div className="tool-group">
        <IconButton label="画像追加" onClick={() => imageInputRef.current?.click()}>
          <ImagePlus size={17} />
        </IconButton>
        <IconButton active={tool === "text"} label="テキスト" onClick={() => setToolAndMessage("text")}>
          <Type size={17} />
        </IconButton>
        <IconButton label="四角形" onClick={addRectangle}>
          <Square size={17} />
        </IconButton>
        <IconButton label="円" onClick={addCircle}>
          <CircleIcon size={17} />
        </IconButton>
        <IconButton active={tool === "line"} label="直線" onClick={startLineTool}>
          <Slash size={17} />
        </IconButton>
      </div>

      <div className="tool-group">
        <IconButton active={tool === "pen"} label="ペン" onClick={() => setToolAndMessage("pen")}>
          <Brush size={17} />
        </IconButton>
        <IconButton active={tool === "bucket"} label="バケツ" onClick={() => setToolAndMessage("bucket")}>
          <PaintBucket size={17} />
        </IconButton>
        <IconButton label="削除" onClick={deleteSelectedObject}>
          <Trash2 size={17} />
        </IconButton>
      </div>
    </aside>
  );

  const layerPanel = () => (
    <section className="panel layer-panel">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Layer</span>
          <h2>レイヤー</h2>
        </div>
        <button className="ghost-button small-icon-button" onClick={addLayer} title="レイヤー追加" type="button">
          <Plus size={16} />
          <span>追加</span>
        </button>
      </div>
      <div className="layer-list">
        {layers.map((layer) => (
          <div
            className={`layer-row ${activeLayerId === layer.id ? "selected" : ""} ${layer.role === "base" ? "locked" : ""}`}
            key={layer.id}
          >
            <button
              className="layer-name"
              disabled={layer.role === "base"}
              onClick={() => setActiveLayerId(layer.id)}
              type="button"
            >
              {layer.role === "base" ? <Lock size={14} /> : <Shapes size={14} />}
              {layerLabel(layer)}
            </button>
            <button
              aria-label={layer.visible ? `${layer.name}を非表示` : `${layer.name}を表示`}
              className="mini-button"
              onClick={() => toggleLayerVisibility(layer.id)}
              title={layer.visible ? "非表示" : "表示"}
              type="button"
            >
              {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            <button className="mini-button" disabled={layer.role === "base"} onClick={() => moveLayer(layer.id, -1)} type="button">
              ↑
            </button>
            <button className="mini-button" disabled={layer.role === "base"} onClick={() => moveLayer(layer.id, 1)} type="button">
              ↓
            </button>
          </div>
        ))}
      </div>
    </section>
  );

  const propsPanel = () => (
    <section className="panel props-panel">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Style</span>
          <h2>プロパティ</h2>
        </div>
      </div>
      <label className="field color-field">
        <span>線・文字色</span>
        <input aria-label="線・文字色" onChange={(event) => setColor(event.target.value)} type="color" value={color} />
      </label>
      <label className="field color-field">
        <span>塗り色</span>
        <input aria-label="塗り色" onChange={(event) => setFillColor(event.target.value)} type="color" value={fillColor} />
      </label>
      <label className="field">
        <span>線幅</span>
        <input
          max="40"
          min="1"
          onChange={(event) => setStrokeWidth(Number(event.target.value))}
          type="range"
          value={strokeWidth}
        />
        <strong className="value-chip">{strokeWidth}px</strong>
      </label>
      <label className="field">
        <span>線種</span>
        <select onChange={(event) => setBrushKind(event.target.value as BrushKind)} value={brushKind}>
          <option value="normal">通常線</option>
          <option value="pressure">圧力で太く</option>
        </select>
      </label>
      <label className="field">
        <span>フォント</span>
        <select onChange={(event) => setFontFamily(event.target.value)} value={fontFamily}>
          {FONT_OPTIONS.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </select>
      </label>
      <div className="selection-card">
        <span>選択中</span>
        <strong>{selectedObject ? selectedObject.type || "オブジェクト" : "なし"}</strong>
      </div>
    </section>
  );

  const canvasPanel = () => (
    <section className="canvas-area" aria-label="編集キャンバス">
      <div
        className={`canvas-panel ${tool === "text" ? "is-text-tool" : ""}`}
        onClick={handleCanvasClick}
        onDoubleClick={handleCanvasDoubleClick}
        ref={canvasPanelRef}
      >
        <div className="canvas-stage">
          <canvas ref={canvasElementRef} />
        </div>
      </div>
    </section>
  );

  return (
    <main className={`app-shell ${tool === "text" ? "cursor-text-mode" : ""}`}>
      <nav className="mobile-tabs" aria-label="パネル切り替え">
        <button
          className={`mobile-tab ${mobilePanel === "canvas" ? "is-active" : ""}`}
          onClick={() => setMobilePanel("canvas")}
          type="button"
        >
          キャンバス
        </button>
        <button
          className={`mobile-tab ${mobilePanel === "layers" ? "is-active" : ""}`}
          onClick={() => setMobilePanel("layers")}
          type="button"
        >
          レイヤー
        </button>
        <button
          className={`mobile-tab ${mobilePanel === "props" ? "is-active" : ""}`}
          onClick={() => setMobilePanel("props")}
          type="button"
        >
          スタイル
        </button>
      </nav>

      <div className="layout-shell">
      <section className={`workspace ${mobilePanel}`}>
        {toolPanel()}
        {canvasPanel()}
        <aside className="inspector">
          {layerPanel()}
          {propsPanel()}
        </aside>
      </section>
      </div>
    </main>
  );
}
