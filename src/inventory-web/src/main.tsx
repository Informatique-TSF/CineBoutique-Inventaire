import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import "./styles/util-classes.css";
import { App } from "./App";
import { initializeTheme } from "./app/utils/theme";
import { setupPwa } from "./pwa/setupPwa";
import { UpdateToast } from "./pwa/UpdateToast";
import { ShopProvider } from "./state/ShopContext";

initializeTheme();

const root = createRoot(document.getElementById("root")!);

if (import.meta.env.PROD) {
  setupPwa();
}

root.render(
  <StrictMode>
    <ShopProvider>
      <App />
    </ShopProvider>
    <UpdateToast />
  </StrictMode>
);
