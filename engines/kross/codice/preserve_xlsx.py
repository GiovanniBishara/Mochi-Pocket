"""Write only guest and optional ID strings into an XLSX calendar.

All other archive entries and every byte outside the changed cells stay intact.
No formulas, styles, calculation caches, dates or finance cells are rewritten.
"""
import argparse
import copy
from decimal import Decimal, InvalidOperation
import json
import posixpath
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
MAX_SAFE_INTEGER = 2**53 - 1


def column_index(column):
    if not isinstance(column, str) or not re.fullmatch(r'[A-Z]{1,3}', column):
        raise ValueError('Colonna ID non valida.')
    index = 0
    for character in column:
        index = index * 26 + ord(character) - ord('A') + 1
    return index


def allowed_columns(id_column):
    if id_column is None:
        return {'C'}
    if not 4 <= column_index(id_column) <= 16384:
        raise ValueError('Colonna ID non valida: deve essere da D a XFD.')
    return {'C', id_column}


def sheet_path(archive, name):
    root = ET.fromstring(archive.read('xl/workbook.xml'))
    sheets = [s for s in root.find('s:sheets', NS) if s.get('name') == name]
    if len(sheets) != 1:
        raise ValueError(f'Foglio non trovato o duplicato: {name}')
    rid = sheets[0].get('{' + NS['r'] + '}id')
    rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
    matches = [r for r in rels if r.get('Id') == rid and r.get('TargetMode') != 'External']
    if len(matches) != 1:
        raise ValueError('Relazione del foglio non valida.')
    target = matches[0].get('Target', '')
    resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
    if not resolved.startswith('xl/') or resolved not in archive.namelist():
        raise ValueError('Percorso foglio non valido.')
    return resolved


def strings(archive):
    if 'xl/sharedStrings.xml' not in archive.namelist():
        return []
    return [''.join(el.itertext()) for el in ET.fromstring(archive.read('xl/sharedStrings.xml'))]


def value(cell, shared, *, identifier=False):
    if cell is None:
        return ''
    if cell.find('s:f', NS) is not None:
        raise ValueError('La cella ospite o ID contiene una formula.')
    kind = cell.get('t')
    if kind in ('b', 'e'):
        raise ValueError('La cella ospite o ID contiene un booleano o un errore.')
    if kind == 'inlineStr':
        inline = cell.find('s:is', NS)
        result = ''.join(inline.itertext()) if inline is not None else ''
        return result.strip() if identifier else result
    v = cell.find('s:v', NS)
    if v is None or v.text is None:
        return ''
    if kind == 's':
        result = shared[int(v.text)]
        return result.strip() if identifier else result
    if identifier and kind in (None, 'n'):
        try:
            numeric = Decimal(v.text)
        except InvalidOperation as exc:
            raise ValueError('La cella ID numerica non è valida.') from exc
        if not numeric.is_finite() or numeric != numeric.to_integral_value() or abs(numeric) > MAX_SAFE_INTEGER:
            raise ValueError('La cella ID numerica non è un intero sicuro.')
        return str(int(numeric))
    if kind in ('str', None):
        return v.text.strip() if identifier else v.text
    raise ValueError('La cella ospite non contiene una stringa.')


def transplant(source_path, donor_path, output_path, sheet, patches, id_column=None):
    """``donor_path`` is optional: when given, every new value must also match it."""
    columns = allowed_columns(id_column)
    if Path(source_path).resolve() == Path(output_path).resolve():
        raise ValueError('Scrivere prima in un file temporaneo, mai direttamente sul sorgente.')
    with ZipFile(source_path) as source:
        target = sheet_path(source, sheet)
        original = source.read(target).decode('utf-8')
        donor = ZipFile(donor_path) if donor_path else None
        donor_xml = ET.fromstring(donor.read(sheet_path(donor, sheet))) if donor else None
        source_cells = {c.get('r'): c for c in ET.fromstring(original).findall('.//s:sheetData/s:row/s:c', NS)}
        donor_cells = {c.get('r'): c for c in donor_xml.findall('.//s:sheetData/s:row/s:c', NS)} if donor else {}
        source_strings, donor_strings = strings(source), (strings(donor) if donor else [])
        if donor:
            donor.close()
        updates = {}
        for patch in patches:
            column = patch.get('column')
            if column not in columns or type(patch.get('row')) is not int or patch['row'] < 1:
                raise ValueError('Modifica fuori dalle colonne ospite e ID consentite.')
            coordinate = column + str(patch['row'])
            if coordinate in updates or not isinstance(patch.get('before'), str) or not isinstance(patch.get('after'), str):
                raise ValueError('Modifica duplicata o valore non testuale.')
            is_identifier = column == id_column
            if id_column is not None:
                if not isinstance(patch.get('expectedGuest'), str) or not isinstance(patch.get('expectedId'), str):
                    raise ValueError('Manca la coppia originale ospite/ID da verificare.')
                original_guest = value(source_cells.get('C' + str(patch['row'])), source_strings)
                original_id = value(source_cells.get(id_column + str(patch['row'])), source_strings, identifier=True)
                if original_guest != patch['expectedGuest'] or original_id != patch['expectedId']:
                    raise ValueError(f'{sheet}!{patch["row"]}: la coppia ospite/ID è cambiata durante la preparazione.')
            if value(source_cells.get(coordinate), source_strings, identifier=is_identifier) != patch['before']:
                raise ValueError(f'{sheet}!{coordinate}: il valore è cambiato durante la preparazione.')
            existing = source_cells.get(coordinate)
            if existing is not None and any(child.tag not in ('{' + NS['s'] + '}v', '{' + NS['s'] + '}is') for child in existing):
                raise ValueError(f'{coordinate}: contenuto nativo della cella non supportato; nessuna modifica salvata.')
            # Read donor as literal strings: numeric ID normalization is only
            # for checking existing calendar values, never for changing output.
            authored = value(donor_cells.get(coordinate), donor_strings) if donor_xml is not None else patch['after']
            if authored != patch['after'] and not (patch['after'].startswith('=') and authored == "'" + patch['after']):
                raise ValueError(f'{coordinate}: il valore esportato non corrisponde alla modifica richiesta.')
            updates[coordinate] = (patch['after'], is_identifier)

        result = original
        for coordinate, (after, is_identifier) in updates.items():
            # XML cell replacements leave row attributes and unrelated cells byte-identical.
            pattern = re.compile(r'<c\b(?=[^>]*\br=["\']' + re.escape(coordinate) + r'["\'])[^>]*(?:/>|>.*?</c>)', re.S)
            matches = list(pattern.finditer(result))
            content = '<is><t xml:space="preserve">' + escape(after).replace('\r', '&#13;') + '</t></is>'
            if len(matches) == 1:
                match = matches[0]
                opening = re.match(r'<c\b[^>]*>', match.group()).group()
                opening = re.sub(r'\s+t=["\'][^"\']*["\']', '', opening)
                opening = opening[:-2] if opening.endswith('/>') else opening[:-1]
                replacement = opening + ' t="inlineStr">' + content + '</c>'
                result = result[:match.start()] + replacement + result[match.end():]
            elif not matches and coordinate not in source_cells:
                column, row = re.fullmatch(r'([A-Z]+)([1-9]\d*)', coordinate).groups()
                row_pattern = re.compile(r'(<row\b(?=[^>]*\br=["\']' + row + r'["\'])[^>]*>)(.*?)(</row>)', re.S)
                row_match = row_pattern.search(result)
                if not row_match:
                    raise ValueError(f'Riga calendario assente: {row}')
                body = row_match.group(2)
                cells = list(re.finditer(r'<c\b[^>]*\br=["\']([A-Z]+)\d+["\'][^>]*(?:/>|>.*?</c>)', body, re.S))
                insertion = next((c.start() for c in cells if column_index(c.group(1)) > column_index(column)), len(body))
                cell_xml = f'<c r="{coordinate}" t="inlineStr">{content}</c>'
                body = body[:insertion] + cell_xml + body[insertion:]
                result = result[:row_match.start(2)] + body + result[row_match.end(2):]
            else:
                raise ValueError(f'XML non supportato o cella duplicata: {coordinate}')
        final_cells = {c.get('r'): c for c in ET.fromstring(result).findall('.//s:sheetData/s:row/s:c', NS)}
        for coordinate, (after, is_identifier) in updates.items():
            if value(final_cells.get(coordinate), source_strings) != after:
                raise ValueError(f'Verifica finale fallita: {coordinate}')
        for coordinate in set(source_cells) | set(final_cells):
            if coordinate not in updates:
                if ET.tostring(source_cells.get(coordinate)) != ET.tostring(final_cells.get(coordinate)):
                    raise ValueError(f'Cella estranea modificata: {coordinate}')
        with ZipFile(output_path, 'w') as output:
            output.comment = source.comment
            for member in source.infolist():
                # writestr mutates header_offset/CRC on ZipInfo. Keep the input
                # archive's index unchanged so subsequent verification reads it.
                output.writestr(copy.copy(member), result.encode('utf-8') if member.filename == target else source.read(member))
        with ZipFile(output_path) as output:
            if source.namelist() != output.namelist():
                raise ValueError('Sono cambiati i componenti del file Excel.')
            for member in source.namelist():
                if member != target and source.read(member) != output.read(member):
                    raise ValueError('Componente estraneo modificato: ' + member)


if __name__ == '__main__':
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('source', 'output', 'sheet', 'patches'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--donor')
    parser.add_argument('--id-column')
    args = parser.parse_args()
    try:
        transplant(args.source, args.donor, args.output, args.sheet,
                   json.loads(Path(args.patches).read_text(encoding='utf-8')), args.id_column)
        print('Verifica archivio Excel completata: modificate soltanto le celle ospite e ID previste.')
    except Exception as exc:
        print(f'Errore di conservazione Excel: {exc}', file=sys.stderr)
        raise SystemExit(1)
