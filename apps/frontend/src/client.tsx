import { createRoot } from "react-dom/client";

import { Mockup } from "./Mockup";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(<Mockup />);
