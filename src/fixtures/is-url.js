module.exports = (url) => {
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
};
