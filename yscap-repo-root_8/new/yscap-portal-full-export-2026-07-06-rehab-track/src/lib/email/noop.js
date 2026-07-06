module.exports = {
  name: 'none',
  async sendMail({ to, subject }) {
    console.log(`[email:none] would send "${subject}" -> ${to}`);
    return { ok: false, skipped: true };
  },
};
