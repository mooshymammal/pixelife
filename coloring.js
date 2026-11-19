(() => {
  "use strict";

  const transferPrefix = "pixel-art-numbering-tool:";
  const canvas = document.getElementById("coloringCanvas");
  const numberLayer = document.getElementById("coloringNumberLayer");
  const viewport = document.getElementById("canvasViewport");
  const ctx = canvas.getContext("2d");
  const status = document.getElementById("coloringStatus");
  const paletteContainer = document.getElementById("palette");
  const cellAssignments = new Map();
  const palette = [];
  const undoStack = [];
  const colorNumbers = new Map();
  const restrictedColors = new Set();
  let coloringSaveQueue = Promise.resolve();
  let coloringSaveError = null;
  let selectedColor = null;
  let data;
  let cellSize;
  let fitScale = 1;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let canvasNumbersVisible = true;
  let renderedNumberRange = "";
  let pointerGesture = null;
  let pinchGesture = null;
  const activePointers = new Map();

  function setStatus(message) {
    status.textContent = message;
  }

  function captureColoringState() {
    return {
      assignments: new Map(cellAssignments),
      palette: [...palette],
      selectedColor,
      colorNumbers: new Map(colorNumbers),
      restrictedColors: new Set(restrictedColors)
    };
  }

  function coloringStatesMatch(first, second) {
    if (first.assignments.size !== second.assignments.size
      || first.palette.length !== second.palette.length
      || first.selectedColor !== second.selectedColor
      || first.colorNumbers.size !== second.colorNumbers.size
      || first.restrictedColors.size !== second.restrictedColors.size) return false;
    for (const [index, color] of first.assignments) {
      if (second.assignments.get(index) !== color) return false;
    }
    for (const [color, number] of first.colorNumbers) {
      if (second.colorNumbers.get(color) !== number) return false;
    }
    return first.palette.every((color, index) => color === second.palette[index])
      && [...first.restrictedColors].every((color) => second.restrictedColors.has(color));
  }

  function recordUndoState(state) {
    if (coloringStatesMatch(state, captureColoringState())) return;
    undoStack.push(state);
    if (undoStack.length > 50) undoStack.shift();
    document.getElementById("undoColoringBtn").disabled = false;
  }

  function saveColoringProject() {
    if (!data || !data.projectId) return;
    const coloring = {
      palette: [...palette],
      assignments: [...cellAssignments],
      colorNumbers: [...colorNumbers],
      restrictedColors: [...restrictedColors]
    };
    coloringSaveQueue = coloringSaveQueue.then(async () => {
      const project = await window.PixelArtProjects.get(data.projectId);
      if (!project) throw new Error("The project no longer exists in this browser.");
      await window.PixelArtProjects.save({ ...project, coloring, updatedAt: Date.now() });
      coloringSaveError = null;
    }).catch((error) => {
      coloringSaveError = error;
      setStatus(`Coloring autosave failed: ${error.message}`);
    });
    return coloringSaveQueue;
  }

  function restoreSavedColoring(saved) {
    if (!saved || !Array.isArray(saved.palette) || !Array.isArray(saved.assignments)) return;
    const savedPalette = saved.palette.filter((color) => (
      typeof color === "string" && /^#[0-9A-F]{6}$/i.test(color)
    ));
    palette.splice(0, palette.length, ...savedPalette);
    cellAssignments.clear();
    saved.assignments.forEach(([index, color]) => {
      if (Number.isInteger(index) && index >= 0 && index < data.columns * data.rows
        && palette.includes(color)) {
        cellAssignments.set(index, color);
      }
    });
    if (Array.isArray(saved.colorNumbers)) {
      colorNumbers.clear();
      saved.colorNumbers.forEach(([color, number]) => {
        if (typeof color === "string" && Number.isInteger(number) && number > 0) {
          colorNumbers.set(color, number);
        }
      });
    }
    if (Array.isArray(saved.restrictedColors)) {
      restrictedColors.clear();
      saved.restrictedColors.forEach((color) => {
        if (colorNumbers.has(color)) restrictedColors.add(color);
      });
    }
    selectedColor = null;
  }

  function undoColoring() {
    const previous = undoStack.pop();
    if (!previous) return;
    cellAssignments.clear();
    previous.assignments.forEach((color, index) => cellAssignments.set(index, color));
    palette.splice(0, palette.length, ...previous.palette);
    colorNumbers.clear();
    previous.colorNumbers.forEach((number, color) => colorNumbers.set(color, number));
    restrictedColors.clear();
    previous.restrictedColors.forEach((color) => restrictedColors.add(color));
    selectedColor = previous.selectedColor;
    renderPalette();
    renderedNumberRange = "";
    drawGrid();
    renderNumberLayer(currentScale() > 1);
    document.getElementById("undoColoringBtn").disabled = undoStack.length === 0;
    setStatus("Last coloring change undone.");
    saveColoringProject();
  }

  function readGridData() {
    if (!window.name.startsWith(transferPrefix)) return null;
    const serialized = window.name.slice(transferPrefix.length);
    window.name = "";
    return JSON.parse(serialized);
  }

  function isValidGridData(value) {
    return value
      && Number.isInteger(value.columns)
      && Number.isInteger(value.rows)
      && value.columns > 0
      && value.rows > 0
      && Array.isArray(value.grid)
      && value.grid.length === value.rows
      && Array.isArray(value.palette)
      && value.palette.every((color) => /^#[0-9A-F]{6}$/i.test(color))
      && value.grid.every((row) => Array.isArray(row)
        && row.length === value.columns
        && row.every((id) => Number.isInteger(id) && id > 0 && id <= value.palette.length));
  }

  function numberForGridId(id) {
    const color = data.palette[id - 1]?.toUpperCase();
    return colorNumbers.get(color) ?? id;
  }

  function canColorGridId(color, id) {
    return !restrictedColors.has(color)
      || colorNumbers.get(color) === numberForGridId(id);
  }

  function drawGrid() {
    const width = data.columns * cellSize;
    const height = data.rows * cellSize;
    const drawCanvasNumbers = currentScale() <= 1;
    canvasNumbersVisible = drawCanvasNumbers;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    numberLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.max(7, Math.floor(cellSize * 0.38))}px Arial, sans-serif`;

    for (let y = 0; y < data.rows; y++) {
      for (let x = 0; x < data.columns; x++) {
        const id = data.grid[y][x];
        const color = cellAssignments.get(y * data.columns + x) || "#FFFFFF";
        const px = x * cellSize;
        const py = y * cellSize;
        ctx.fillStyle = color;
        ctx.fillRect(px, py, cellSize, cellSize);
        if (drawCanvasNumbers) {
          ctx.fillStyle = "#111111";
          ctx.fillText(String(numberForGridId(id)), px + cellSize / 2, py + cellSize / 2, cellSize - 2);
        }
      }
    }

    ctx.beginPath();
    for (let x = 0; x <= data.columns; x++) {
      const px = x === data.columns ? canvas.width - 0.5 : x * cellSize + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, canvas.height);
    }
    for (let y = 0; y <= data.rows; y++) {
      const py = y === data.rows ? canvas.height - 0.5 : y * cellSize + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(canvas.width, py);
    }
    ctx.strokeStyle = "rgba(25, 30, 40, 0.65)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function renderNumberLayer(visible) {
    if (!visible) {
      if (numberLayer.childElementCount) numberLayer.replaceChildren();
      renderedNumberRange = "";
      return;
    }

    const scale = currentScale();
    const logicalWidth = data.columns * cellSize;
    const logicalHeight = data.rows * cellSize;
    const centerX = viewport.clientWidth / 2 + panX;
    const centerY = viewport.clientHeight / 2 + panY;
    const minX = Math.max(0, Math.floor(((0 - centerX) / scale + logicalWidth / 2) / cellSize) - 1);
    const maxX = Math.min(data.columns - 1, Math.ceil(((viewport.clientWidth - centerX) / scale + logicalWidth / 2) / cellSize) + 1);
    const minY = Math.max(0, Math.floor(((0 - centerY) / scale + logicalHeight / 2) / cellSize) - 1);
    const maxY = Math.min(data.rows - 1, Math.ceil(((viewport.clientHeight - centerY) / scale + logicalHeight / 2) / cellSize) + 1);
    const range = `${minX}:${maxX}:${minY}:${maxY}`;
    if (renderedNumberRange === range) return;

    const fragment = document.createDocumentFragment();
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", String((x + 0.5) * cellSize));
        label.setAttribute("y", String((y + 0.5) * cellSize));
        label.setAttribute("fill", "#111111");
        label.setAttribute("font-family", "Arial, sans-serif");
        label.setAttribute("font-size", String(Math.max(7, Math.floor(cellSize * 0.38))));
        label.setAttribute("font-weight", "700");
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "central");
        label.textContent = String(numberForGridId(data.grid[y][x]));
        fragment.append(label);
      }
    }
    numberLayer.replaceChildren(fragment);
    renderedNumberRange = range;
  }

  function currentScale() {
    return fitScale * zoom;
  }

  function updateTransform() {
    if (!canvas.width || !canvas.height) return;
    const logicalWidth = data.columns * cellSize;
    const logicalHeight = data.rows * cellSize;
    const scale = currentScale();
    canvas.style.left = `${viewport.clientWidth / 2 + panX}px`;
    canvas.style.top = `${viewport.clientHeight / 2 + panY}px`;
    canvas.style.width = `${logicalWidth * scale}px`;
    canvas.style.height = `${logicalHeight * scale}px`;
    canvas.style.transform = "translate(-50%, -50%)";
    numberLayer.style.left = canvas.style.left;
    numberLayer.style.top = canvas.style.top;
    numberLayer.style.width = canvas.style.width;
    numberLayer.style.height = canvas.style.height;
    numberLayer.style.transform = canvas.style.transform;
    document.getElementById("zoomLevel").textContent = `${Math.round(zoom * 100)}%`;
    if (canvasNumbersVisible !== (scale <= 1)) drawGrid();
    renderNumberLayer(scale > 1);
  }

  function updateFitScale() {
    if (!canvas.width || !canvas.height || !viewport.clientWidth || !viewport.clientHeight) return;
    fitScale = Math.min(viewport.clientWidth / canvas.width, viewport.clientHeight / canvas.height);
    updateTransform();
  }

  function fitSheet() {
    zoom = 1;
    panX = 0;
    panY = 0;
    updateFitScale();
  }

  function zoomAt(clientX, clientY, factor) {
    const nextZoom = Math.max(0.5, Math.min(12, zoom * factor));
    const rect = viewport.getBoundingClientRect();
    const centerX = rect.left + viewport.clientWidth / 2;
    const centerY = rect.top + viewport.clientHeight / 2;
    const imageX = (clientX - centerX - panX) / currentScale();
    const imageY = (clientY - centerY - panY) / currentScale();
    zoom = nextZoom;
    panX = clientX - centerX - imageX * currentScale();
    panY = clientY - centerY - imageY * currentScale();
    updateTransform();
  }

  function selectColor(color) {
    selectedColor = color;
    renderPalette();
    const fillMode = document.getElementById("fillMode").value;
    const assignedNumber = colorNumbers.get(color);
    const restriction = restrictedColors.has(color) && assignedNumber !== undefined
      ? ` Fills are limited to number ${assignedNumber}.`
      : "";
    const instruction = fillMode === "number"
      ? `Click a numbered cell to fill every cell with that number.${restriction}`
      : `Click one cell to color only that cell.${restriction}`;
    setStatus(`Selected ${color}. ${instruction}`);
  }

  function assignColorNumber(color, value) {
    const nextNumber = Number(value);
    const currentNumber = colorNumbers.get(color);
    if (!Number.isInteger(nextNumber) || nextNumber < 1 || nextNumber > data.palette.length) {
      setStatus(`Choose a number from 1 to ${data.palette.length}.`);
      renderPalette();
      return;
    }
    if (nextNumber === currentNumber) return;

    const previous = captureColoringState();
    const otherColor = [...colorNumbers].find(([itemColor, number]) => (
      itemColor !== color && number === nextNumber
    ))?.[0];
    if (otherColor) colorNumbers.set(otherColor, currentNumber);
    colorNumbers.set(color, nextNumber);
    recordUndoState(previous);
    renderPalette();
    renderedNumberRange = "";
    drawGrid();
    renderNumberLayer(currentScale() > 1);
    setStatus(otherColor
      ? `Swapped numbers ${currentNumber} and ${nextNumber}.`
      : `${color} is now number ${nextNumber}.`);
    saveColoringProject();
  }

  function setColorRestriction(color, restricted) {
    const previous = captureColoringState();
    if (restricted) restrictedColors.add(color);
    else restrictedColors.delete(color);
    recordUndoState(previous);
    renderPalette();
    const number = colorNumbers.get(color);
    setStatus(restricted
      ? `${color} is restricted to cells numbered ${number}.`
      : `${color} can now fill cells with any number.`);
    saveColoringProject();
  }

  function renderPalette() {
    paletteContainer.replaceChildren();
    palette.forEach((color) => {
      const item = document.createElement("div");
      item.className = "palette-item";

      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.className = "palette-select";
      selectButton.setAttribute("aria-label", `Select ${color}`);
      selectButton.setAttribute("aria-pressed", String(selectedColor === color));
      selectButton.addEventListener("click", () => selectColor(color));

      const swatch = document.createElement("span");
      swatch.className = "palette-swatch";
      swatch.style.backgroundColor = color;
      const label = document.createElement("code");
      label.textContent = color;
      selectButton.append(swatch, label);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "palette-remove";
      removeButton.textContent = "Remove";
      removeButton.setAttribute("aria-label", `Remove ${color} from palette`);
      removeButton.addEventListener("click", () => {
        const previous = captureColoringState();
        const index = palette.indexOf(color);
        if (index >= 0) palette.splice(index, 1);
        cellAssignments.forEach((assignedColor, cellIndex) => {
          if (assignedColor === color) cellAssignments.delete(cellIndex);
        });
        if (selectedColor === color) selectedColor = null;
        recordUndoState(previous);
        renderPalette();
        drawGrid();
        setStatus(`${color} removed from the palette.`);
        saveColoringProject();
      });

      const header = document.createElement("div");
      header.className = "palette-item-header";
      header.append(selectButton, removeButton);
      item.append(header);

      const settings = document.createElement("div");
      settings.className = "palette-item-settings";
      const assignedNumber = colorNumbers.get(color);
      if (assignedNumber !== undefined) {
        const numberLabel = document.createElement("label");
        numberLabel.className = "palette-number-setting";
        numberLabel.textContent = "Number";
        const numberInput = document.createElement("input");
        numberInput.type = "number";
        numberInput.min = "1";
        numberInput.max = String(data.palette.length);
        numberInput.step = "1";
        numberInput.value = String(assignedNumber);
        numberInput.setAttribute("aria-label", `Number for ${color}`);
        numberInput.addEventListener("change", () => assignColorNumber(color, numberInput.value));
        numberLabel.append(numberInput);

        const restrictionLabel = document.createElement("label");
        restrictionLabel.className = "palette-lock-setting";
        const restrictionInput = document.createElement("input");
        restrictionInput.type = "checkbox";
        restrictionInput.checked = restrictedColors.has(color);
        restrictionInput.setAttribute("aria-label", `Restrict ${color} to number ${assignedNumber}`);
        restrictionInput.addEventListener("change", () => {
          setColorRestriction(color, restrictionInput.checked);
        });
        const restrictionText = document.createElement("span");
        restrictionText.textContent = `Only fill #${assignedNumber}`;
        restrictionLabel.append(restrictionInput, restrictionText);
        settings.append(numberLabel, restrictionLabel);
      } else {
        const customNote = document.createElement("span");
        customNote.className = "palette-custom-note";
        customNote.textContent = "Custom color · fills any number";
        settings.append(customNote);
      }

      item.append(settings);
      paletteContainer.append(item);
    });
  }

  document.getElementById("addColorBtn").addEventListener("click", () => {
    const color = document.getElementById("colorPicker").value.toUpperCase();
    const previous = captureColoringState();
    if (!palette.includes(color)) palette.push(color);
    recordUndoState(previous);
    selectColor(color);
    saveColoringProject();
  });

  document.getElementById("clearColorsBtn").addEventListener("click", () => {
    const previous = captureColoringState();
    cellAssignments.clear();
    recordUndoState(previous);
    drawGrid();
    setStatus("All cells are white again. Your palette is unchanged.");
    saveColoringProject();
  });

  document.getElementById("fillPaletteBtn").addEventListener("click", () => {
    if (!data) return;
    const previous = captureColoringState();
    let filled = 0;
    data.grid.forEach((row, y) => row.forEach((id, x) => {
      cellAssignments.set(y * data.columns + x, data.palette[id - 1].toUpperCase());
      filled++;
    }));
    recordUndoState(previous);
    drawGrid();
    setStatus(`Filled all ${filled} cells with the original image colors.`);
    saveColoringProject();
  });

  document.getElementById("saveColoringPngBtn").addEventListener("click", () => {
    if (!data || !canvas.width || !canvas.height) return;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const exportCtx = exportCanvas.getContext("2d");
    for (let y = 0; y < data.rows; y++) {
      for (let x = 0; x < data.columns; x++) {
        exportCtx.fillStyle = cellAssignments.get(y * data.columns + x) || "#FFFFFF";
        exportCtx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }

    exportCanvas.toBlob((blob) => {
      if (!blob) {
        setStatus("Could not create the colored PNG file.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "colored-pixel-art.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Saving your colored grid as PNG.");
    }, "image/png");
  });
    document.getElementById("undoColoringBtn").addEventListener("click", undoColoring);

  document.getElementById("fillMode").addEventListener("change", () => {
    if (selectedColor) selectColor(selectedColor);
  });

  function getCellAt(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    const centerX = rect.left + viewport.clientWidth / 2 + panX;
    const centerY = rect.top + viewport.clientHeight / 2 + panY;
    const scale = currentScale();
    const x = Math.floor(((clientX - centerX) / scale + canvas.width / 2) / cellSize);
    const y = Math.floor(((clientY - centerY) / scale + canvas.height / 2) / cellSize);
    if (x < 0 || x >= data.columns || y < 0 || y >= data.rows) return null;
    return { x, y, id: data.grid[y][x] };
  }

  function paintCellsBetween(startX, startY, endX, endY, visited) {
    const start = getCellAt(startX, startY);
    const end = getCellAt(endX, endY);
    if (!start || !end || !selectedColor) return { id: null, number: null, filled: 0, blocked: 0 };

    const distance = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
    const steps = Math.max(1, distance);
    let id = end.id;
    let filled = 0;
    let blocked = 0;
    for (let step = 0; step <= steps; step++) {
      const x = Math.round(start.x + (end.x - start.x) * step / steps);
      const y = Math.round(start.y + (end.y - start.y) * step / steps);
      id = data.grid[y][x];
      const number = numberForGridId(id);
      const fillMode = document.getElementById("fillMode").value;
      const key = fillMode === "number" ? `number:${number}` : `cell:${y * data.columns + x}`;
      if (visited.has(key)) continue;
      visited.add(key);

      if (fillMode === "number") {
        let groupSize = 0;
        data.grid.forEach((row, rowIndex) => row.forEach((cellId, columnIndex) => {
          if (numberForGridId(cellId) === numberForGridId(id)) {
            if (!canColorGridId(selectedColor, cellId)) {
              blocked++;
              return;
            }
            cellAssignments.set(rowIndex * data.columns + columnIndex, selectedColor);
            groupSize++;
          }
        }));
        filled += groupSize;
      } else {
        if (!canColorGridId(selectedColor, id)) {
          blocked++;
          continue;
        }
        cellAssignments.set(y * data.columns + x, selectedColor);
        filled++;
      }
    }

    return { id, number: numberForGridId(id), filled, blocked };
  }

  function fillCellAt(clientX, clientY) {
    if (!selectedColor) {
      setStatus("Add and select a palette color before filling cells.");
      return;
    }

    const previous = captureColoringState();
    const result = paintCellsBetween(clientX, clientY, clientX, clientY, new Set());
    if (result.filled === 0) {
      if (result.blocked) {
        setStatus(`This cell is number ${result.number}; ${selectedColor} is restricted to number ${colorNumbers.get(selectedColor)}.`);
      }
      return;
    }
    recordUndoState(previous);
    drawGrid();
    if (document.getElementById("fillMode").value === "number") {
      setStatus(`Filled ${result.filled} cells numbered ${result.number} with ${selectedColor}.`);
    } else {
      setStatus(`Filled one cell numbered ${result.number} with ${selectedColor}.`);
    }
    saveColoringProject();
  }

  function paintFromGesture(gesture, clientX, clientY) {
    const result = paintCellsBetween(gesture.lastX, gesture.lastY, clientX, clientY, gesture.visited);
    gesture.lastX = clientX;
    gesture.lastY = clientY;
    if (result.filled > 0) {
      drawGrid();
      setStatus(result.blocked
        ? `Painted with ${selectedColor}; skipped ${result.blocked} cells outside its assigned number.`
        : `Painting cells with ${selectedColor}.`);
    } else if (result.blocked) {
      setStatus(`${selectedColor} is restricted to number ${colorNumbers.get(selectedColor)}.`);
    }
  }

  viewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);

    if (activePointers.size === 2) {
      const pointerIds = [...activePointers.keys()];
      const first = activePointers.get(pointerIds[0]);
      const second = activePointers.get(pointerIds[1]);
      const midpointX = (first.x + second.x) / 2;
      const midpointY = (first.y + second.y) / 2;
      const rect = viewport.getBoundingClientRect();
      const centerX = rect.left + viewport.clientWidth / 2;
      const centerY = rect.top + viewport.clientHeight / 2;
      pinchGesture = {
        pointerIds,
        startDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        startZoom: zoom,
        imageX: (midpointX - centerX - panX) / currentScale(),
        imageY: (midpointY - centerY - panY) / currentScale()
      };
      pointerGesture = null;
      viewport.classList.add("is-panning");
      viewport.classList.remove("is-painting");
      return;
    }

    const startedOnCanvas = event.target === canvas;
    pointerGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      panX,
      panY,
      startedOnCanvas,
      paintMode: startedOnCanvas && Boolean(selectedColor) && !event.shiftKey,
      visited: new Set(),
      startColoringState: captureColoringState(),
      moved: false
    };
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pinchGesture) {
      const first = activePointers.get(pinchGesture.pointerIds[0]);
      const second = activePointers.get(pinchGesture.pointerIds[1]);
      if (!first || !second) return;
      const midpointX = (first.x + second.x) / 2;
      const midpointY = (first.y + second.y) / 2;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const rect = viewport.getBoundingClientRect();
      const centerX = rect.left + viewport.clientWidth / 2;
      const centerY = rect.top + viewport.clientHeight / 2;
      zoom = Math.max(0.5, Math.min(12, pinchGesture.startZoom * distance / pinchGesture.startDistance));
      panX = midpointX - centerX - pinchGesture.imageX * currentScale();
      panY = midpointY - centerY - pinchGesture.imageY * currentScale();
      updateTransform();
      return;
    }

    if (!pointerGesture || event.pointerId !== pointerGesture.pointerId) return;
    const deltaX = event.clientX - pointerGesture.startX;
    const deltaY = event.clientY - pointerGesture.startY;
    if (!pointerGesture.moved && Math.hypot(deltaX, deltaY) > 4) {
      pointerGesture.moved = true;
      viewport.classList.add(pointerGesture.paintMode ? "is-painting" : "is-panning");
    }
    if (pointerGesture.moved) {
      if (pointerGesture.paintMode) {
        paintFromGesture(pointerGesture, event.clientX, event.clientY);
      } else {
        panX = pointerGesture.panX + deltaX;
        panY = pointerGesture.panY + deltaY;
        updateTransform();
      }
    }
  });

  function finishPointerGesture(event) {
    activePointers.delete(event.pointerId);
    if (pinchGesture) {
      pinchGesture = null;
      pointerGesture = null;
      viewport.classList.remove("is-panning");
      return;
    }
    if (!pointerGesture || event.pointerId !== pointerGesture.pointerId) return;
    if (!pointerGesture.moved && pointerGesture.startedOnCanvas) {
      fillCellAt(event.clientX, event.clientY);
    } else if (pointerGesture.moved && pointerGesture.paintMode) {
      recordUndoState(pointerGesture.startColoringState);
      saveColoringProject();
    }
    pointerGesture = null;
    viewport.classList.remove("is-panning");
    viewport.classList.remove("is-painting");
  }

  viewport.addEventListener("pointerup", finishPointerGesture);
  viewport.addEventListener("pointercancel", (event) => {
    activePointers.delete(event.pointerId);
    if (pointerGesture && pointerGesture.pointerId === event.pointerId
      && pointerGesture.moved && pointerGesture.paintMode) {
      recordUndoState(pointerGesture.startColoringState);
    }
    pinchGesture = null;
    pointerGesture = null;
    viewport.classList.remove("is-panning");
    viewport.classList.remove("is-painting");
  });

  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  document.getElementById("zoomInBtn").addEventListener("click", () => {
    zoomAt(
      viewport.getBoundingClientRect().left + viewport.clientWidth / 2,
      viewport.getBoundingClientRect().top + viewport.clientHeight / 2,
      1.25
    );
  });

  document.getElementById("zoomOutBtn").addEventListener("click", () => {
    zoomAt(
      viewport.getBoundingClientRect().left + viewport.clientWidth / 2,
      viewport.getBoundingClientRect().top + viewport.clientHeight / 2,
      1 / 1.25
    );
  });

  document.getElementById("fitGridBtn").addEventListener("click", fitSheet);

  const toolPanel = document.getElementById("coloringToolPanel");
  const toolPanelButtons = [...document.querySelectorAll("[data-tool-panel]")];
  const toolPanelSections = [...toolPanel.querySelectorAll(".tool-panel-section")];
  toolPanelButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const panelId = button.dataset.toolPanel;
      const isActive = button.getAttribute("aria-pressed") === "true";
      if (isActive && !toolPanel.hidden) {
        toolPanel.hidden = true;
        button.setAttribute("aria-pressed", "false");
        return;
      }

      toolPanel.hidden = false;
      toolPanelSections.forEach((section) => {
        section.hidden = section.id !== panelId;
      });
      toolPanelButtons.forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || toolPanel.hidden) return;
    toolPanel.hidden = true;
    toolPanelButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
  });

  const leaveDialog = document.getElementById("leaveColoringDialog");
  const confirmLeaveButton = document.getElementById("confirmLeaveBtn");
  const leaveSaveError = document.getElementById("leaveSaveError");
  document.getElementById("returnToProjectsBtn").addEventListener("click", () => {
    leaveSaveError.hidden = true;
    leaveDialog.showModal();
  });
  document.getElementById("cancelLeaveBtn").addEventListener("click", () => {
    leaveDialog.close();
  });
  confirmLeaveButton.addEventListener("click", async () => {
    confirmLeaveButton.disabled = true;
    confirmLeaveButton.textContent = "Saving...";
    leaveSaveError.hidden = true;
    try {
      await saveColoringProject();
      if (coloringSaveError) {
        leaveSaveError.hidden = false;
        return;
      }
      window.location.assign("index.html");
    } finally {
      if (leaveDialog.open) {
        confirmLeaveButton.disabled = false;
        confirmLeaveButton.textContent = "Return to Projects";
      }
    }
  });

  async function initializeGrid() {
    let savedProject = null;
    const requestedProjectId = new URLSearchParams(location.search).get("projectId");
    try {
      data = readGridData();
    } catch {
      setStatus("The coloring grid data could not be read. Return to the generator and open the coloring page again.");
      return;
    }

    const projectId = data?.projectId || requestedProjectId;
    if (!isValidGridData(data) && projectId) {
      try {
        savedProject = await window.PixelArtProjects.get(projectId);
        data = savedProject?.generated || null;
        if (data) data.projectId = projectId;
      } catch (error) {
        setStatus(`Could not load the saved project: ${error.message}`);
        return;
      }
    } else if (projectId) {
      data.projectId = projectId;
      try {
        savedProject = await window.PixelArtProjects.get(projectId);
      } catch (error) {
        setStatus(`Saved coloring could not be loaded: ${error.message}`);
      }
    }

    if (!isValidGridData(data)) {
      setStatus("No numbered grid was received. Return to Projects and open a generated project.");
      return;
    }

    cellSize = Math.max(8, Math.min(Number(data.cellSize) || 28, Math.floor(5000 / Math.max(data.columns, data.rows))));
    data.palette.forEach((color, index) => {
      const normalized = color.toUpperCase();
      if (!palette.includes(normalized)) palette.push(normalized);
      colorNumbers.set(normalized, index + 1);
      restrictedColors.add(normalized);
    });
    restoreSavedColoring(savedProject?.coloring);
    document.getElementById("fillPaletteBtn").disabled = false;
    document.getElementById("saveColoringPngBtn").disabled = false;
    document.getElementById("undoColoringBtn").disabled = true;
    renderPalette();
    document.getElementById("coloringDimensions").textContent = `${data.columns} columns × ${data.rows} rows`;
    if (palette.length) {
      setStatus("Choose a color from the image palette or add a custom color, then click a cell.");
    }
    drawGrid();
    fitSheet();
    window.addEventListener("resize", updateFitScale);
  }

  initializeGrid();
})();
