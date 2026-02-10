import { BrowserRouter, Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import AgencyDetail from "./pages/AgencyDetail";
import RegulationView from "./pages/RegulationView";
import ConnectionStatus from "./components/ConnectionStatus";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/agency/:slug" element={<AgencyDetail />} />
        <Route path="/regulation/:titleNumber" element={<RegulationView />} />
      </Routes>
      <ConnectionStatus />
    </BrowserRouter>
  );
}

export default App;
