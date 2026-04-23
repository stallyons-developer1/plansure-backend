const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");
const {
  uploadProgramme,
  getProgramme,
  debugPDF,
} = require("../controllers/programmeController");

router.post("/upload", upload.single("pdf"), uploadProgramme);
router.post("/debug", upload.single("pdf"), debugPDF);
router.get("/", getProgramme);

module.exports = router;
