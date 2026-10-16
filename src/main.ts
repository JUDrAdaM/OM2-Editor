import "./style.css";
import { EditorApp } from "./ui/app";
import { StartMenu } from "./ui/menu";
import type { OmsiMap } from "./omsi/types";

const root = document.getElementById("app");
if (root) {
  const app = new EditorApp();

  const showEditor = (map: OmsiMap, status: string) => {
    app.mount(root);
    app.loadMap(map, status);
  };

  const showMenu = () => {
    const menu = new StartMenu(root, showEditor);
    void menu.show();
  };

  app.onBackToMenu = showMenu;

  // Rychlé načtení z URL parametrů (dev náhled v prohlížeči), jinak úvodní menu.
  const params = new URLSearchParams(location.search);
  if (params.has("omsimap") || params.has("map")) {
    app.mount(root);
    app.tryLoadFromUrlParams();
  } else {
    showMenu();
  }
}
