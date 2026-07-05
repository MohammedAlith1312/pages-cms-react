import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

// Lazy import pages when they exist — for now routing skeleton
function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="pages-cms-theme">
      <BrowserRouter>
        <Routes>
          {/* Auth routes */}
          <Route path="/sign-in" element={<div>Sign In (coming soon)</div>} />
          <Route path="/sign-in/collaborator" element={<div>Collaborator Sign In</div>} />

          {/* Main routes */}
          <Route path="/" element={<div>Home (coming soon)</div>} />
          <Route path="/admin" element={<div>Admin (coming soon)</div>} />
          <Route path="/settings" element={<div>Settings (coming soon)</div>} />
          <Route path="/:owner/:repo" element={<div>Repo (coming soon)</div>} />
          <Route path="/:owner/:repo/:branch/*" element={<div>Repo Branch (coming soon)</div>} />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </ThemeProvider>
  );
}

export default App;
