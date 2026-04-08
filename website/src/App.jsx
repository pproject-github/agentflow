import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Home from './pages/Home.jsx';
import Docs from './pages/Docs.jsx';
import DocDetail from './pages/DocDetail.jsx';
import Demo from './pages/Demo.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="docs" element={<Docs />} />
        <Route path="docs/:lang/:slug" element={<DocDetail />} />
        <Route path="demo" element={<Demo />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}