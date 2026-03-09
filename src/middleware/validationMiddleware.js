function validateWebhook(req, res, next) {
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Empty request body'
    });
  }
  next();
}

module.exports = { validateWebhook };