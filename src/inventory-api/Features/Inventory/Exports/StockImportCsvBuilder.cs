using System.Globalization;
using System.Text;

namespace CineBoutique.Inventory.Api.Features.Inventory.Exports;

/// <summary>
/// Fichier d'import de stock MCS, au format des imports de décembre 2025 :
/// <c>office;item_id;loc_total_invent;locd_trans_date;locd_trans_cost</c>, une ligne par référence,
/// séparateur « ; », fins de ligne CRLF, sans BOM, date jj/mm/aaaa, coût 0.
/// MCS additionne les lignes : une référence n'apparaît donc qu'une fois, et les stocks à 0 ne sont pas importés
/// (le stock existant est remis à zéro par le fichier d'annulation, fait avant).
/// </summary>
internal static class StockImportCsvBuilder
{
    internal const string Header = "office;item_id;loc_total_invent;locd_trans_date;locd_trans_cost";

    public static byte[] Build(string officeCode, IEnumerable<ReconciledStock> stock, DateTime exportDate)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(officeCode);
        ArgumentNullException.ThrowIfNull(stock);

        var office = officeCode.Trim();
        var date = exportDate.ToString("dd/MM/yyyy", CultureInfo.InvariantCulture);

        var builder = new StringBuilder();
        builder.Append(Header).Append("\r\n");

        foreach (var line in stock.Where(item => item.IsImported).OrderBy(item => item.Sku, StringComparer.OrdinalIgnoreCase))
        {
            builder
                .Append(office).Append(';')
                .Append(line.Sku).Append(';')
                .Append(FormatQuantity(line.Quantity)).Append(';')
                .Append(date).Append(';')
                .Append('0')
                .Append("\r\n");
        }

        return new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(builder.ToString());
    }

    internal static string FormatQuantity(decimal quantity) =>
        quantity.ToString("0.###", CultureInfo.InvariantCulture);
}
