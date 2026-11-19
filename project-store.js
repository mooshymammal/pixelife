(() => {
  "use strict";

  const databaseName = "pixel-art-numbering-projects";
  const storeName = "projects";
  let databasePromise;

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(storeName, { keyPath: "id" });
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {
            database.close();
            databasePromise = null;
          };
          resolve(database);
        };
        request.onerror = () => reject(request.error || new Error("Could not open project storage."));
        request.onblocked = () => reject(new Error("Project storage is blocked by another open page."));
      });
    }
    return databasePromise;
  }

  function readRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not read project storage."));
    });
  }

  async function get(id) {
    const database = await openDatabase();
    const transaction = database.transaction(storeName, "readonly");
    return readRequest(transaction.objectStore(storeName).get(id));
  }

  async function list() {
    const database = await openDatabase();
    const transaction = database.transaction(storeName, "readonly");
    const projects = await readRequest(transaction.objectStore(storeName).getAll());
    return projects.sort((first, second) => second.updatedAt - first.updatedAt);
  }

  async function write(action) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      try {
        action(transaction.objectStore(storeName));
      } catch (error) {
        transaction.abort();
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not save project."));
      transaction.onabort = () => reject(transaction.error || new Error("Project save was aborted."));
    });
  }

  window.PixelArtProjects = Object.freeze({
    get,
    list,
    save(project) {
      return write((store) => store.put(project));
    },
    remove(id) {
      return write((store) => store.delete(id));
    }
  });
})();
