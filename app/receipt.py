"""Private stdin JSON -> one local PDF. No guest data is written to stdout/stderr."""
import json
import os
import sys
from datetime import date
from pathlib import Path

from reportlab import __file__ as reportlab_file
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


class LayoutError(ValueError):
    pass


def register_fonts():
    windows = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    packaged = Path(reportlab_file).parent / "fonts"
    for name, primary, fallback in [
        ("Receipt", "calibri.ttf", "Vera.ttf"),
        ("Receipt-Bold", "calibrib.ttf", "VeraBd.ttf"),
        ("Receipt-BoldItalic", "calibriz.ttf", "VeraBI.ttf"),
    ]:
        font = windows / primary
        if not font.is_file():
            font = packaged / fallback
        pdfmetrics.registerFont(TTFont(name, str(font)))


def wrapped(text, width, font="Receipt", size=12):
    lines = []
    line = ""
    for word in text.split():
        candidate = f"{line} {word}" if line else word
        if pdfmetrics.stringWidth(candidate, font, size) <= width:
            line = candidate
            continue
        if line:
            lines.append(line)
            line = ""
        # Long unbroken tax IDs or street names must not paint outside the column.
        for char in word:
            if line and pdfmetrics.stringWidth(line + char, font, size) > width:
                lines.append(line)
                line = char
            else:
                line += char
    if line:
        lines.append(line)
    return lines


def block(lines, width):
    return [item for line in lines if line for item in wrapped(line, width)]


def italian_date(value):
    return date.fromisoformat(value).strftime("%d/%m/%Y")


def money(cents):
    # Integer arithmetic only, including formatting.
    units, fraction = divmod(cents, 100)
    return f"{units:,}".replace(",", ".") + f",{fraction:02d}"


def exclusive_output(folder, filename):
    folder.mkdir(parents=True, exist_ok=True)
    for index in range(10000):
        suffix = f" ({index + 1})" if index else ""
        output = folder / f"{filename}{suffix}.pdf"
        try:
            return output, output.open("xb")
        except FileExistsError:
            continue
    raise OSError("No unused receipt filename available")


def generate(payload):
    profile = payload["profile"]
    receipt = payload["receipt"]
    issuer = profile["issuer"]
    property_ = profile["property"]
    amounts = [receipt[key] for key in ("rentCents", "cityTaxCents", "totalCents")]
    if any(type(value) is not int or value < 0 for value in amounts) or amounts[0] + amounts[1] != amounts[2]:
        raise ValueError("Invalid amounts")
    arrival = date.fromisoformat(receipt["arrival"])
    departure = date.fromisoformat(receipt["departure"])
    if departure < arrival:
        raise ValueError("Invalid stay")
    register_fonts()

    left, right = 52.92, 371.35
    emitter_lines = [property_["name"], issuer["name"], *issuer["address"], f'{issuer["taxLabel"]}: {issuer["taxId"]}']
    company = receipt["recipientCompany"]
    recipient_name = receipt["recipientName"]
    # The addressee is already printed in the salutation. Retain a distinct
    # company contact, without repeating the same person or company name.
    contact = [recipient_name] if company and recipient_name and recipient_name != company else []
    recipient_lines = [*contact, *receipt["recipientAddress"]]
    if receipt["recipientTaxId"]:
        recipient_lines.append(f'{receipt["recipientTaxLabel"]}: {receipt["recipientTaxId"]}')
    emitter_lines = block(emitter_lines, 299)
    recipient_lines = block(recipient_lines, 187)
    if max(len(emitter_lines), len(recipient_lines)) > 14:
        raise LayoutError("Address block too tall")
    salutation = f'{"Spett.le" if company else "Gent."} {company or recipient_name}'
    salutation_size = 12 if pdfmetrics.stringWidth(salutation, "Receipt", 12) <= 187 else 10
    salutation_lines = wrapped(salutation, 187, size=salutation_size)
    if len(salutation_lines) > 2:
        raise LayoutError("Recipient name too long")

    description_y = min(523.15, 647.98 - max(len(emitter_lines), len(recipient_lines)) * 15.6 - 30)
    description = f'CANONE UTILIZZO NOSTRA STRUTTURA ({property_["kind"]}) SITA IN {property_["city"]}'.upper()
    description_lines = wrapped(description, 496)
    if arrival == departure:
        stay = f'{property_["address"]}, IL GIORNO {italian_date(receipt["arrival"])}'
    else:
        stay = f'{property_["address"]}, DAL {italian_date(receipt["arrival"])} AL {italian_date(receipt["departure"])}'
    stay_lines = wrapped(stay.upper(), 390)
    first_description_y = description_y - 31.2
    first_stay_y = first_description_y - len(description_lines) * 15.6
    rent_y = first_stay_y - (len(stay_lines) - 1) * 15.6
    tax_y, total_y = rent_y - 31.2, rent_y - 62.4
    payment_lines = wrapped(f'Metodo di pagamento: {receipt["paymentMethod"]}', 496) if receipt["paymentMethod"] else []
    if total_y - 40 - len(payment_lines) * 15.6 < 75:
        raise LayoutError("Receipt body too tall")

    output, handle = exclusive_output(Path(payload["outputDir"]).resolve(), payload["filename"])
    try:
        pdf = canvas.Canvas(handle, pagesize=(612, 792))
        pdf.setTitle(f'Ricevuta N. {receipt["number"]}')
        pdf.setAuthor(issuer["name"])
        pdf.setCreator("Mochi Pocket - ricevute locali")

        def text(x, y, value, font="Receipt", align="left", size=12, width=None):
            if width:
                while size > 8 and pdfmetrics.stringWidth(value, font, size) > width:
                    size -= 0.25
                if pdfmetrics.stringWidth(value, font, size) > width:
                    raise LayoutError("Text wider than receipt column")
            pdf.setFont(font, size)
            if align == "right":
                pdf.drawRightString(x, y, value)
            elif align == "center":
                pdf.drawCentredString(x, y, value)
            else:
                pdf.drawString(x, y, value)

        text(left, 694.78, "RICEVUTA N.", "Receipt-BoldItalic")
        text(178.67, 694.78, receipt["number"], "Receipt-BoldItalic", "center", width=110)
        text(left, 679.18, "Data emissione:", "Receipt-BoldItalic")
        text(179.85, 679.18, italian_date(receipt["issueDate"]), "Receipt-Bold", "center")
        for index, line in enumerate(salutation_lines):
            text(right, 679.18 - index * 13, line, size=salutation_size)
        for index, line in enumerate(emitter_lines):
            text(left, 647.98 - index * 15.6, line)
        for index, line in enumerate(recipient_lines):
            text(right, 647.98 - index * 15.6, line)

        text(left, description_y, "DESCRIZIONE:", "Receipt-BoldItalic")
        for index, line in enumerate(description_lines):
            text(left, first_description_y - index * 15.6, line)
        for index, line in enumerate(stay_lines):
            text(left, first_stay_y - index * 15.6, line)
        text(482.08, rent_y, "Euro", align="right")
        text(549.52, rent_y, money(receipt["rentCents"]), align="right", width=62)
        text(left, tax_y, "IMPOSTA DI SOGGIORNO")
        text(482.08, tax_y, "Euro", align="right")
        text(549.52, tax_y, money(receipt["cityTaxCents"]), align="right", width=62)
        pdf.setLineWidth(1.0)
        pdf.line(419.41, tax_y - 3.66, 549.52, tax_y - 3.66)
        text(417.262, total_y, "TOTALE", align="right")
        text(482.08, total_y, "Euro", align="right")
        text(549.52, total_y, money(receipt["totalCents"]), align="right", width=62)
        for index, line in enumerate(payment_lines):
            text(left, total_y - 40 - index * 15.6, line, size=11)
        pdf.showPage()
        pdf.save()
        handle.close()
    except Exception:
        handle.close()
        output.unlink(missing_ok=True)
        raise
    return {"ok": True, "path": str(output), "totalCents": receipt["totalCents"]}


if __name__ == "__main__":
    try:
        result = generate(json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"ok": False, "code": "RECEIPT_LAYOUT" if isinstance(error, LayoutError) else "RECEIPT_PDF"}))
        sys.exit(1)
