(() => {
  "use strict";

  const projectList = document.getElementById("projectList");
  const status = document.getElementById("projectLibraryStatus");
  const emptyState = document.getElementById("emptyProjects");
  const count = document.getElementById("projectCount");
  const previewUrls = new Set();
  const imageInput = document.getElementById("newProjectImage");

  function createProjectId() {
    return typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function projectNameFromFile(filename) {
    return filename.replace(/\.[^.]+$/, "") || "Untitled project";
  }

  function createProjectCard(project) {
    const card = document.createElement("article");
    card.className = "project-card card";

    if (project.sourceImage instanceof Blob) {
      const preview = document.createElement("img");
      const url = URL.createObjectURL(project.sourceImage);
      previewUrls.add(url);
      preview.className = "project-preview";
      preview.src = url;
      preview.alt = "";
      card.append(preview);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "project-preview project-preview-empty";
      placeholder.textContent = "Pixel art";
      card.append(placeholder);
    }

    const content = document.createElement("div");
    content.className = "project-card-content";
    const title = document.createElement("h3");
    title.textContent = project.name || "Untitled project";
    const details = document.createElement("p");
    details.className = "muted";
    details.textContent = project.generated
      ? `${project.generated.columns} × ${project.generated.rows} grid · ${project.generated.palette.length} colors`
      : "Image ready to generate";
    const updated = document.createElement("p");
    updated.className = "project-updated";
    updated.textContent = `Updated ${new Date(project.updatedAt || project.createdAt).toLocaleString()}`;
    content.append(title, details, updated);

    const actions = document.createElement("div");
    actions.className = "project-card-actions";
    const open = document.createElement("a");
    open.className = "button primary";
    open.href = `generator.html?projectId=${encodeURIComponent(project.id)}`;
    open.textContent = "Open project";
    actions.append(open);

    if (project.generated) {
      const coloring = document.createElement("a");
      coloring.className = "button secondary";
      coloring.href = `coloring.html?projectId=${encodeURIComponent(project.id)}`;
      coloring.textContent = "Continue coloring";
      actions.append(coloring);
    }

    const remove = document.createElement("button");
    remove.className = "button secondary project-delete-button";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${title.textContent}`);
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${title.textContent}" from this browser?`)) return;
      remove.disabled = true;
      try {
        await window.PixelArtProjects.remove(project.id);
        await renderProjects();
      } catch (error) {
        remove.disabled = false;
        status.textContent = `Could not delete the project: ${error.message}`;
      }
    });
    actions.append(remove);
    content.append(actions);
    card.append(content);
    return card;
  }

  async function renderProjects() {
    status.textContent = "Loading projects…";
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.clear();
    const projects = await window.PixelArtProjects.list();
    projectList.replaceChildren(...projects.map(createProjectCard));
    count.textContent = `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
    emptyState.hidden = projects.length > 0;
    status.textContent = projects.length ? "" : "Your saved projects will appear here.";
  }

  imageInput.addEventListener("change", async () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      status.textContent = "Please choose a valid image file.";
      imageInput.value = "";
      return;
    }

    imageInput.disabled = true;
    status.textContent = "Saving your project and preparing its coloring grid…";
    const id = createProjectId();
    const timestamp = Date.now();
    try {
      await window.PixelArtProjects.save({
        id,
        name: projectNameFromFile(file.name),
        sourceName: file.name,
        sourceImage: file,
        generated: null,
        coloring: null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      location.href = `generator.html?projectId=${encodeURIComponent(id)}&openColoring=1`;
    } catch (error) {
      status.textContent = `Could not save this project: ${error.message}`;
      imageInput.disabled = false;
      imageInput.value = "";
    }
  });

  renderProjects().catch((error) => {
    status.textContent = `Could not load projects: ${error.message}`;
  });

  window.addEventListener("pagehide", () => {
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
  });
})();
