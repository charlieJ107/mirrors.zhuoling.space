import { BrowserRouter, Routes, Route } from "react-router";
import Index from "@client/app/index";
import NotFound from "@client/app/notfound";
import Messages from "@client/app/messages";
import SignIn from "@client/app/sign-in";
import SignUp from "@client/app/sign-up";
import Dashboard from "@client/app/dashboard";
import { AppShell } from "@client/components/app/shell";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/sign-up" element={<SignUp />} />
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/messages" element={<Messages />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
