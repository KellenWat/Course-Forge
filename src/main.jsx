import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import GolfCourseCreator from "../golf-course-creator.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <GolfCourseCreator />
  </StrictMode>
);
