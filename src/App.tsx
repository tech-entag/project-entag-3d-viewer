import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Viewer from './pages/viewer'
import Home from './pages'
import EmbedPartWorkbench from './pages/embed/part'

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path='/viewer' element={<Viewer />} />
        <Route path='/embed/part' element={<EmbedPartWorkbench />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App