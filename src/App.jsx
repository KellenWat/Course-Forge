import { useState } from "react";
import HomeScreen from "./HomeScreen.jsx";
import DrivingRange from "./DrivingRange.jsx";
import GolfCourseCreator from "../golf-course-creator.jsx";

export default function App() {
  const [screen, setScreen] = useState("home");

  if (screen === "driving-range") {
    return <DrivingRange onClose={() => setScreen("home")} />;
  }
  if (screen === "creator" || screen === "play") {
    return <GolfCourseCreator onHome={() => setScreen("home")} />;
  }
  return <HomeScreen onSelect={setScreen} />;
}
