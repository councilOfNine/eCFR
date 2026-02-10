import { Router } from 'express'
import db from '../db.js'

const router = Router()

router.get('/', (_req, res) => {
  try {
    const totalAgencies = db.prepare('SELECT COUNT(*) as count FROM agencies WHERE parent_slug IS NULL').get()
    const totalSubAgencies = db.prepare('SELECT COUNT(*) as count FROM agencies WHERE parent_slug IS NOT NULL').get()
    const totalTitles = db.prepare('SELECT COUNT(*) as count FROM titles WHERE reserved = 0').get()
    const totalWordCount = db.prepare('SELECT SUM(word_count) as total FROM agencies WHERE parent_slug IS NULL').get()
    const lastFetched = db.prepare('SELECT MAX(last_fetched) as last FROM agencies').get()

    const topAgencies = db.prepare(`
      SELECT a.slug, a.name, a.short_name, a.word_count,
        a.word_count + COALESCE((SELECT SUM(c.word_count) FROM agencies c WHERE c.parent_slug = a.slug), 0) as total_word_count
      FROM agencies a
      WHERE a.parent_slug IS NULL AND a.word_count > 0
      ORDER BY total_word_count DESC
      LIMIT 15
    `).all()

    const ingestStatus = db.prepare('SELECT * FROM ingest_status WHERE id = 1').get()

    res.json({
      total_agencies: totalAgencies.count,
      total_sub_agencies: totalSubAgencies.count,
      total_titles: totalTitles.count,
      total_word_count: totalWordCount.total || 0,
      last_fetched: lastFetched.last,
      top_agencies: topAgencies,
      ingest_status: ingestStatus,
    })
  } catch (err) {
    console.error('Error fetching stats:', err)
    res.status(500).json({ error: 'Failed to fetch stats' })
  }
})

export default router
