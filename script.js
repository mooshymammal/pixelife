(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const imageInput = $("imageInput");
  const generateBtn = $("generateBtn");
  const status = $("status");
  const canvas = $("resultCanvas");
  const ctx = canvas.getContext("2d");
  const settingIds = [
    "columnsInput",
    "rowsInput",
    "colorLimitInput",
    "labelMode",
    "cellSizeInput",
    "showGridInput",
    "whiteBlocksInput"
  ];
  const coloringTransferPrefix = "pixel-art-numbering-tool:";
  const directColoring = new URLSearchParams(location.search).get("openColoring") === "1";
  let sourceImage = null;
  let sourceImageBlob = null;
  let sourceImageName = "";
  let legendText = "";
  let coloringData = null;
  let projectId = null;
  let projectSaveQueue = Promise.resolve();

  function setSettingsEnabled(enabled) {
    settingIds.forEach((id) => {
      $(id).disabled = !enabled;
    });
  }

  function setStatus(message) {
    status.textContent = message;
    const directStatus = $("directColoringMessage");
    if (directStatus) directStatus.textContent = message;
  }

  function clampInteger(value, min, max, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  }

  function createProjectId() {
    return typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function projectNameFromFile(filename) {
    return filename.replace(/\.[^.]+$/, "") || "Untitled project";
  }

  function saveProjectFields(fields) {
    const id = projectId;
    if (!id) return Promise.resolve(false);
    let saved = false;
    projectSaveQueue = projectSaveQueue.then(async () => {
      const project = await window.PixelArtProjects.get(id);
      if (!project) throw new Error("The project no longer exists in this browser.");
      await window.PixelArtProjects.save({ ...project, ...fields, updatedAt: Date.now() });
      saved = true;
    }).catch((error) => {
      setStatus(`Project autosave failed: ${error.message}`);
    });
    return projectSaveQueue.then(() => saved);
  }

  function navigateToColoringPage(replaceHistory) {
    if (!coloringData) return;
    coloringData.projectId = projectId;
    window.name = coloringTransferPrefix + JSON.stringify(coloringData);
    const projectQuery = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const url = `coloring.html${projectQuery}`;
    if (replaceHistory) location.replace(url);
    else location.href = url;
  }

  function renderSavedGrid(savedGrid) {
    if (!savedGrid || !Array.isArray(savedGrid.palette) || !Array.isArray(savedGrid.grid)) return false;
    const paletteEntries = savedGrid.palette.map((hex, index) => ({
      id: index + 1,
      hex,
      count: 0
    }));
    const grid = savedGrid.grid.map((row) => row.map((id) => {
      const entry = paletteEntries[id - 1];
      if (entry) entry.count++;
      return { id, hex: entry?.hex || "#FFFFFF" };
    }));

    coloringData = savedGrid;
    $("columnsInput").value = savedGrid.columns;
    $("rowsInput").value = savedGrid.rows;
    $("cellSizeInput").value = savedGrid.cellSize;
    $("colorLimitInput").value = savedGrid.colorLimit || 64;
    $("labelMode").value = savedGrid.labelMode || "number";
    $("showGridInput").checked = savedGrid.showGrid !== false;
    $("whiteBlocksInput").checked = savedGrid.whiteBlocks === true;
    drawGrid(grid, paletteEntries, savedGrid.columns, savedGrid.rows, savedGrid.cellSize);
    renderLegend(paletteEntries);
    $("results").classList.remove("hidden");
    $("dimensions").textContent = `${savedGrid.columns} columns × ${savedGrid.rows} rows`;
    $("summary").textContent = `${savedGrid.palette.length} colors · ${savedGrid.columns * savedGrid.rows} blocks`;
    $("downloadPngBtn").disabled = false;
    $("downloadSvgBtn").disabled = false;
    $("coloringBtn").disabled = false;
    $("copyLegendBtn").disabled = false;
    return true;
  }

  async function loadProjectFromUrl() {
    const requestedProjectId = new URLSearchParams(location.search).get("projectId");
    if (!requestedProjectId) {
      if (directColoring) setStatus("No project was selected. Return to Projects and choose an image.");
      return;
    }
    try {
      const project = await window.PixelArtProjects.get(requestedProjectId);
      if (!project) {
        setStatus("This project could not be found in this browser.");
        return;
      }
      projectId = project.id;
      sourceImageBlob = project.sourceImage;
      sourceImageName = project.sourceName || "pixel-art-image";
      if (!(sourceImageBlob instanceof Blob)) {
        setStatus("The source image for this project is missing.");
        return;
      }

      $("fileName").textContent = sourceImageName;
      setSettingsEnabled(true);
      generateBtn.disabled = false;
      const imageUrl = URL.createObjectURL(sourceImageBlob);
      const image = new Image();
      image.onload = async () => {
        sourceImage = image;
        URL.revokeObjectURL(imageUrl);
        const restored = renderSavedGrid(project.generated);
        if (!restored) {
          setDefaultSettings(image);
          await generate();
        } else {
          setStatus("Project loaded from your library. Changes are saved automatically.");
          if (directColoring) navigateToColoringPage(true);
        }
      };
      image.onerror = () => {
        setStatus("The saved project image could not be opened.");
        URL.revokeObjectURL(imageUrl);
      };
      image.src = imageUrl;
    } catch (error) {
      setStatus(`Could not open this project: ${error.message}`);
    }
  }

  function detectPixelSize(image) {
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    const verticalEdges = new Uint32Array(sourceWidth);
    const horizontalEdges = new Uint32Array(sourceHeight);
    const rowCanvas = document.createElement("canvas");
    rowCanvas.width = sourceWidth;
    rowCanvas.height = 1;
    const rowCtx = rowCanvas.getContext("2d", { willReadFrequently: true });
    rowCtx.imageSmoothingEnabled = false;
    const columnCanvas = document.createElement("canvas");
    columnCanvas.width = 1;
    columnCanvas.height = sourceHeight;
    const columnCtx = columnCanvas.getContext("2d", { willReadFrequently: true });
    columnCtx.imageSmoothingEnabled = false;
    const rowSamples = Math.min(32, sourceHeight);
    const columnSamples = Math.min(32, sourceWidth);

    for (let sample = 0; sample < rowSamples; sample++) {
      const y = Math.floor((sample + 1) * sourceHeight / (rowSamples + 1));
      rowCtx.drawImage(image, 0, y, sourceWidth, 1, 0, 0, sourceWidth, 1);
      const pixels = rowCtx.getImageData(0, 0, sourceWidth, 1).data;
      for (let x = 1; x < sourceWidth; x++) {
        const index = x * 4;
        if (
          Math.abs(pixels[index] - pixels[index - 4]) > 8
          || Math.abs(pixels[index + 1] - pixels[index - 3]) > 8
          || Math.abs(pixels[index + 2] - pixels[index - 2]) > 8
          || Math.abs(pixels[index + 3] - pixels[index - 1]) > 8
        ) {
          verticalEdges[x]++;
        }
      }
    }

    for (let sample = 0; sample < columnSamples; sample++) {
      const x = Math.floor((sample + 1) * sourceWidth / (columnSamples + 1));
      columnCtx.drawImage(image, x, 0, 1, sourceHeight, 0, 0, 1, sourceHeight);
      const pixels = columnCtx.getImageData(0, 0, 1, sourceHeight).data;
      for (let y = 1; y < sourceHeight; y++) {
        const index = y * 4;
        const above = index - 4;
        if (
          Math.abs(pixels[index] - pixels[above]) > 8
          || Math.abs(pixels[index + 1] - pixels[above + 1]) > 8
          || Math.abs(pixels[index + 2] - pixels[above + 2]) > 8
          || Math.abs(pixels[index + 3] - pixels[above + 3]) > 8
        ) {
          horizontalEdges[y]++;
        }
      }
    }

    const axes = [verticalEdges, horizontalEdges].map((edges) => {
      const positions = [];
      let total = 0;
      edges.forEach((count, position) => {
        if (count > 0) {
          positions.push({ position, count });
          total += count;
        }
      });
      return positions.length ? { positions, extent: edges.length, total } : null;
    }).filter(Boolean);

    if (!axes.length) return 1;

    const maxCandidate = Math.min(512, Math.floor(Math.min(sourceWidth, sourceHeight) / 2));
    let detectedSize = 1;
    for (let size = 2; size <= maxCandidate; size++) {
      const aligned = axes.every(({ positions, extent, total }) => {
        const counts = new Uint32Array(size);
        positions.forEach(({ position, count }) => {
          counts[position % size] += count;
        });
        let weight = Math.max(1, Math.round(total / positions.length));
        if (extent % size === 0) {
          counts[0] += weight;
          counts[extent % size] += weight;
          total += weight * 2;
        }
        let bestPhase = 0;
        counts.forEach((count) => {
          bestPhase = Math.max(bestPhase, count);
        });
        return bestPhase / total >= 0.95;
      });
      if (aligned) detectedSize = size;
    }

    return detectedSize;
  }

  function setDefaultSettings(image) {
    const pixelSize = detectPixelSize(image);
    const imageColumns = Math.max(1, Math.round(image.naturalWidth / pixelSize));
    const imageRows = Math.max(1, Math.round(image.naturalHeight / pixelSize));
    const maxDimension = Math.max(imageColumns, imageRows);
    const scale = Math.min(1, 250 / maxDimension);
    $("columnsInput").value = Math.max(1, Math.round(imageColumns * scale));
    $("rowsInput").value = Math.max(1, Math.round(imageRows * scale));
    $("colorLimitInput").value = 64;
    $("cellSizeInput").value = 28;
    $("labelMode").value = "number";
    $("showGridInput").checked = true;
    $("whiteBlocksInput").checked = false;
  }

  setSettingsEnabled(false);

  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  // CIELAB distances better match perceived color differences than raw RGB distances.
  function rgbToLab(r, g, b) {
    const linearize = (value) => {
      const channel = value / 255;
      return channel > 0.04045 ? ((channel + 0.055) / 1.055) ** 2.4 : channel / 12.92;
    };
    const red = linearize(r);
    const green = linearize(g);
    const blue = linearize(b);
    const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047;
    const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
    const z = (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) / 1.08883;
    const transform = (value) => value > 0.0088564517
      ? Math.cbrt(value)
      : value / (3 * 0.1379310345 ** 2) + 4 / 29;
    const fx = transform(x);
    const fy = transform(y);
    const fz = transform(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labToRgb(l, a, b) {
    const fy = (l + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const inverse = (value) => value ** 3 > 0.0088564517
      ? value ** 3
      : 3 * 0.1379310345 ** 2 * (value - 4 / 29);
    const x = 0.95047 * inverse(fx);
    const y = inverse(fy);
    const z = 1.08883 * inverse(fz);
    const encode = (value) => {
      const channel = value <= 0.0031308
        ? 12.92 * value
        : 1.055 * value ** (1 / 2.4) - 0.055;
      return Math.max(0, Math.min(255, Math.round(channel * 255)));
    };
    return [
      encode(x * 3.2404542 + y * -1.5371385 + z * -0.4985314),
      encode(x * -0.969266 + y * 1.8760108 + z * 0.041556),
      encode(x * 0.0556434 + y * -0.2040259 + z * 1.0572252)
    ];
  }

  function createPalette(colorCounts, limit) {
    const colors = [...colorCounts].map(([hex, count]) => {
      const [r, g, b] = hex.slice(1).match(/../g).map((value) => parseInt(value, 16));
      return { hex, r, g, b, lab: rgbToLab(r, g, b), count };
    });
    if (colors.length <= limit) return colors;

    const boxes = [colors];
    while (boxes.length < limit) {
      let splitIndex = -1;
      let splitChannel = "";
      let splitScore = -1;

      boxes.forEach((box, index) => {
        if (box.length < 2) return;
        const ranges = ["l", "a", "b"].map((channel, channelIndex) => {
          let min = Infinity;
          let max = -Infinity;
          box.forEach((color) => {
            min = Math.min(min, color.lab[channelIndex]);
            max = Math.max(max, color.lab[channelIndex]);
          });
          return max - min;
        });
        const channelIndex = ranges.indexOf(Math.max(...ranges));
        const score = ranges[channelIndex] * box.reduce((sum, color) => sum + color.count, 0);
        if (score > splitScore) {
          splitIndex = index;
          splitChannel = ["l", "a", "b"][channelIndex];
          splitScore = score;
        }
      });

      if (splitIndex < 0) break;
      const channelIndex = ["l", "a", "b"].indexOf(splitChannel);
      const box = boxes[splitIndex].slice().sort((first, second) => first.lab[channelIndex] - second.lab[channelIndex]);
      const total = box.reduce((sum, color) => sum + color.count, 0);
      let accumulated = 0;
      let midpoint = 1;
      for (; midpoint < box.length; midpoint++) {
        accumulated += box[midpoint - 1].count;
        if (accumulated >= total / 2) break;
      }
      boxes.splice(splitIndex, 1, box.slice(0, midpoint), box.slice(midpoint));
    }

    const paletteByHex = new Map();
    boxes.forEach((box) => {
      const count = box.reduce((sum, color) => sum + color.count, 0);
      const lab = [0, 0, 0];
      box.forEach((color) => {
        color.lab.forEach((value, index) => {
          lab[index] += value * color.count / count;
        });
      });
      const [r, g, b] = labToRgb(...lab);
      const hex = rgbToHex(r, g, b);
      if (!paletteByHex.has(hex)) {
        paletteByHex.set(hex, { hex, r, g, b, lab: rgbToLab(r, g, b), count });
      } else {
        paletteByHex.get(hex).count += count;
      }
    });
    return [...paletteByHex.values()];
  }

  async function generate() {
    if (!sourceImage) {
      setStatus("Choose an image first.");
      return;
    }

    const columns = clampInteger($("columnsInput").value, 1, 250, 32);
    const rows = clampInteger($("rowsInput").value, 1, 250, 32);
    const colorLimit = clampInteger($("colorLimitInput").value, 2, 256, 64);
    const cellSize = clampInteger($("cellSizeInput").value, 12, 80, 28);
    $("columnsInput").value = columns;
    $("rowsInput").value = rows;
    $("colorLimitInput").value = colorLimit;
    $("cellSizeInput").value = cellSize;

    const sample = document.createElement("canvas");
    sample.width = columns;
    sample.height = rows;
    const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
    sampleCtx.imageSmoothingEnabled = false;
    sampleCtx.clearRect(0, 0, columns, rows);
    const scale = Math.min(columns / sourceImage.naturalWidth, rows / sourceImage.naturalHeight);
    const imageWidth = sourceImage.naturalWidth * scale;
    const imageHeight = sourceImage.naturalHeight * scale;
    sampleCtx.drawImage(
      sourceImage,
      (columns - imageWidth) / 2,
      (rows - imageHeight) / 2,
      imageWidth,
      imageHeight
    );

    const pixels = sampleCtx.getImageData(0, 0, columns, rows).data;
    const pixelColors = [];
    const colorCounts = new Map();

    for (let i = 0; i < pixels.length; i += 4) {
      const color = pixels[i + 3] < 128
        ? "#FFFFFF"
        : rgbToHex(pixels[i], pixels[i + 1], pixels[i + 2]);
      pixelColors.push(color);
      colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
    }

    const paletteColors = createPalette(colorCounts, colorLimit);
    const paletteMap = new Map();
    const palette = [];
    const nearestColorCache = new Map();
    const grid = [];

    pixelColors.forEach((originalColor, index) => {
      let paletteIndex = nearestColorCache.get(originalColor);
      if (paletteIndex === undefined) {
        const [r, g, b] = originalColor.slice(1).match(/../g).map((value) => parseInt(value, 16));
        const originalLab = rgbToLab(r, g, b);
        let closestDistance = Infinity;
        paletteColors.forEach((color, index) => {
          const distance = originalLab.reduce((sum, value, channel) => sum + (value - color.lab[channel]) ** 2, 0);
          if (distance < closestDistance) {
            closestDistance = distance;
            paletteIndex = index;
          }
        });
        nearestColorCache.set(originalColor, paletteIndex);
      }

      const paletteColor = paletteColors[paletteIndex];
      if (!paletteMap.has(paletteColor.hex)) {
        const entry = {
          id: palette.length + 1,
          hex: paletteColor.hex,
          count: 0
        };
        paletteMap.set(paletteColor.hex, entry);
        palette.push(entry);
      }
      const entry = paletteMap.get(paletteColor.hex);
      entry.count += 1;
      if (!grid[Math.floor(index / columns)]) grid[Math.floor(index / columns)] = [];
      grid[Math.floor(index / columns)].push({ id: entry.id, hex: entry.hex });
    });

    coloringData = {
      projectId,
      columns,
      rows,
      cellSize,
      colorLimit,
      labelMode: $("labelMode").value,
      showGrid: $("showGridInput").checked,
      whiteBlocks: $("whiteBlocksInput").checked,
      grid: grid.map((row) => row.map((pixel) => pixel.id)),
      palette: palette.map((color) => color.hex)
    };
    drawGrid(grid, palette, columns, rows, cellSize);
    renderLegend(palette);

    $("results").classList.remove("hidden");
    $("dimensions").textContent = `${columns} columns × ${rows} rows`;
    $("summary").textContent = `${palette.length} colors · ${columns * rows} blocks`;
    $("downloadPngBtn").disabled = false;
    $("downloadSvgBtn").disabled = false;
    $("coloringBtn").disabled = false;
    $("copyLegendBtn").disabled = false;
    setStatus("Done! Adjust the settings and generate again to try a different grid.");
    const saved = await saveProjectFields({ generated: coloringData });
    if (directColoring) {
      if (saved) navigateToColoringPage(true);
      else setStatus("The project could not be saved, so coloring was not opened. Return to Projects and try again.");
    }
  }

  function drawGrid(grid, palette, columns, rows, cellSize) {
    canvas.width = columns * cellSize;
    canvas.height = rows * cellSize;
    const mode = $("labelMode").value;
    const showGrid = $("showGridInput").checked;
    const whiteBlocks = $("whiteBlocksInput").checked;
    const fontSize = Math.max(8, Math.min(17, cellSize * 0.34));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const pixel = grid[y][x];
        const px = x * cellSize;
        const py = y * cellSize;
        ctx.fillStyle = whiteBlocks ? "#FFFFFF" : pixel.hex;
        ctx.fillRect(px, py, cellSize, cellSize);

        if (mode !== "none") {
          ctx.fillStyle = "#111111";
          ctx.font = `700 ${fontSize}px Arial, sans-serif`;
          const text = mode === "hex" ? pixel.hex.slice(1, 4) : String(pixel.id);
          ctx.fillText(text, px + cellSize / 2, py + cellSize / 2, cellSize - 2);
        }
      }
    }

    if (showGrid) {
      ctx.beginPath();
      for (let x = 0; x <= columns; x++) {
        const px = x === columns ? canvas.width - 0.5 : x * cellSize + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, canvas.height);
      }
      for (let y = 0; y <= rows; y++) {
        const py = y === rows ? canvas.height - 0.5 : y * cellSize + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(canvas.width, py);
      }
      ctx.strokeStyle = "rgba(25, 30, 40, 0.48)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function renderLegend(palette) {
    const legend = $("legend");
    legend.replaceChildren();
    legendText = palette.map((p) => `${p.id} = ${p.hex} (${p.count} blocks)`).join("\n");

    palette.forEach((p) => {
      const item = document.createElement("div");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.backgroundColor = p.hex;

      const text = document.createElement("div");
      text.className = "legend-text";
      const number = document.createElement("strong");
      number.textContent = `#${p.id}`;
      const hex = document.createElement("code");
      hex.textContent = p.hex;
      const count = document.createElement("div");
      count.className = "muted";
      count.textContent = `${p.count} blocks`;
      text.append(number, hex, count);
      item.append(swatch, text);
      legend.append(item);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  imageInput.addEventListener("change", () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("Please choose a valid image file.");
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = async () => {
      sourceImage = image;
      sourceImageBlob = file;
      sourceImageName = file.name;
      projectId = createProjectId();
      setDefaultSettings(image);
      setSettingsEnabled(true);
      $("fileName").textContent = file.name;
      generateBtn.disabled = false;
      const timestamp = Date.now();
      try {
        await window.PixelArtProjects.save({
          id: projectId,
          name: projectNameFromFile(file.name),
          sourceName: file.name,
          sourceImage: file,
          generated: null,
          coloring: null,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      } catch (error) {
        setStatus(`Could not save this project: ${error.message}`);
      }
      generate();
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      setStatus("The image could not be opened. Try another file.");
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });

  generateBtn.addEventListener("click", generate);
  settingIds.forEach((id) => {
    $(id).addEventListener("change", () => {
      if (sourceImage) generate();
    });
  });
  $("downloadPngBtn").addEventListener("click", () => {
    if (!sourceImage || !sourceImageBlob) return;
    const filename = sourceImageName.replace(/\.[^.]+$/, "") + ".png";
    if (sourceImageBlob.type === "image/png") {
      downloadBlob(sourceImageBlob, filename);
      setStatus("Saving the original image as PNG without the grid or labels.");
      return;
    }

    const originalCanvas = document.createElement("canvas");
    originalCanvas.width = sourceImage.naturalWidth;
    originalCanvas.height = sourceImage.naturalHeight;
    const originalCtx = originalCanvas.getContext("2d");
    originalCtx.drawImage(sourceImage, 0, 0);
    originalCanvas.toBlob((blob) => {
      if (!blob) return setStatus("Could not create the PNG file.");
      downloadBlob(blob, filename);
      setStatus("Saving the original image as PNG without the grid or labels.");
    }, "image/png");
  });
  $("downloadSvgBtn").addEventListener("click", () => {
    if (!sourceImage || !sourceImageBlob) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setStatus("Could not read the original image for the SVG file.");
        return;
      }
      const width = sourceImage.naturalWidth;
      const height = sourceImage.naturalHeight;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="${reader.result}" width="${width}" height="${height}"/></svg>`;
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      downloadBlob(blob, sourceImageName.replace(/\.[^.]+$/, "") + ".svg");
      setStatus("Saving the original image as SVG without the grid or labels.");
    };
    reader.onerror = () => {
      setStatus("Could not read the original image for the SVG file.");
    };
    reader.readAsDataURL(sourceImageBlob);
  });
  $("coloringBtn").addEventListener("click", () => navigateToColoringPage(false));
  $("copyLegendBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(legendText);
      setStatus("Color key copied to clipboard.");
    } catch {
      setStatus("Clipboard access is unavailable in this browser. You can select and copy the color key manually.");
    }
  });

  $("resetBtn").addEventListener("click", () => {
    sourceImage = null;
    sourceImageBlob = null;
    sourceImageName = "";
    legendText = "";
    coloringData = null;
    projectId = null;
    imageInput.value = "";
    $("fileName").textContent = "No image selected";
    $("columnsInput").value = 32;
    $("rowsInput").value = 32;
    $("colorLimitInput").value = 64;
    $("cellSizeInput").value = 28;
    $("labelMode").value = "number";
    $("showGridInput").checked = true;
    $("whiteBlocksInput").checked = false;
    setSettingsEnabled(false);
    generateBtn.disabled = true;
    $("downloadPngBtn").disabled = true;
    $("downloadSvgBtn").disabled = true;
    $("coloringBtn").disabled = true;
    $("copyLegendBtn").disabled = true;
    $("results").classList.add("hidden");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setStatus("Choose an image to begin.");
  });

  loadProjectFromUrl();
})();
