function getHealth(req, res) {
  res.status(200).json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString()
  });
}

module.exports = { getHealth };