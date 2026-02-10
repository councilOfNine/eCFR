import express from 'express'
import cors from 'cors'
import router from './routes/index.js'
import db from './db.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}))
app.use(express.json())

app.use('/api', router)

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
