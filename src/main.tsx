import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { installBrowserDefaultGuards } from "./shared/browserDefaults";
import {UI_LOCALE} from './shared/i18n';

installBrowserDefaultGuards(document);
document.documentElement.lang=UI_LOCALE;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
