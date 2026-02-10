import { Router } from 'express'
import db from '../db.js'

const router = Router()

router.get('/', (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        a.slug,
        a.name,
        a.short_name,
        a.word_count,
        a.checksum,
        a.last_fetched,
        a.parent_slug,
        a.cfr_references,
        COALESCE((SELECT SUM(c.word_count) FROM agencies c WHERE c.parent_slug = a.slug), 0) AS children_word_count,
        (SELECT COUNT(*) FROM agencies c WHERE c.parent_slug = a.slug) AS children_count,
        (SELECT COUNT(*) FROM agency_cfr_content acc WHERE acc.agency_slug = a.slug) AS cfr_content_count
      FROM agencies a
      WHERE a.parent_slug IS NULL
      ORDER BY a.sortable_name ASC
    `).all()

    const wordcounts = rows.map(r => ({
      slug: r.slug,
      name: r.name,
      short_name: r.short_name,
      word_count: r.word_count,
      total_word_count: r.word_count + r.children_word_count,
      children_word_count: r.children_word_count,
      children_count: r.children_count,
      cfr_refs_count: JSON.parse(r.cfr_references || '[]').length,
      cfr_content_count: r.cfr_content_count,
      checksum: r.checksum,
      last_fetched: r.last_fetched,
    }))

    const total = wordcounts.reduce((sum, r) => sum + r.total_word_count, 0)

    res.json({
      total_word_count: total,
      agency_count: wordcounts.length,
      wordcounts,
    })
  } catch (err) {
    console.error('Error fetching word counts:', err)
    res.status(500).json({ error: 'Failed to fetch word counts' })
  }
})

router.post('/compute', (_req, res) => {
  try {
    db.prepare(`
      UPDATE agencies SET
        word_count = COALESCE((SELECT SUM(word_count) FROM agency_cfr_content WHERE agency_slug = agencies.slug), 0),
        checksum = (SELECT GROUP_CONCAT(checksum, '-') FROM agency_cfr_content WHERE agency_slug = agencies.slug),
        last_fetched = datetime('now'),
        updated_at = datetime('now')
    `).run()

    const result = db.prepare(`
      SELECT COUNT(*) as count, SUM(word_count) as total FROM agencies WHERE word_count > 0
    `).get()

    res.json({
      message: 'Word counts recomputed',
      agencies_with_counts: result.count,
      total_word_count: result.total,
    })
  } catch (err) {
    console.error('Error computing word counts:', err)
    res.status(500).json({ error: 'Failed to compute word counts' })
  }
})

export default router
