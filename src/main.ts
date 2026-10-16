import "./style.css";
import { EditorApp } from "./ui/app";

const root = document.getElementById("app");
if (root) {
  new EditorApp().mount(root);
}
