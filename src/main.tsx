import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { installBrowserDefaultGuards } from "./shared/browserDefaults";

installBrowserDefaultGuards(document);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
