from fastapi import FastAPI, UploadFile, File, HTTPException
import tempfile
import os

app = FastAPI()

@app.post("/api/process-pdf")
async def process_pdf(file: UploadFile = File(...)):
    if file.content_type != "application/pdf":
        raise HTTPException(400, "Chỉ nhận file PDF")

    with tempfile.NamedTemporaryFile(
        suffix=".pdf",
        delete=False
    ) as tmp:
        pdf_path = tmp.name
        tmp.write(await file.read())

    try:
        result = process_pdf_file(pdf_path)
        return {
            "success": True,
            "data": result
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        os.remove(pdf_path)
