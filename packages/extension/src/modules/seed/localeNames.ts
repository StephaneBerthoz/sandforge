/**
 * The names a seed draws people and companies from, per locale.
 *
 * Each locale held fifteen first names, fifteen last names and ten companies,
 * and drew the first and the last name from the same index: the thousand
 * contacts of a built-in template were fifteen people — "Alice Smith" some
 * sixty-six times — the five hundred accounts carried ten names, and the
 * org's duplicate rules found a match behind nearly every record. A run now
 * draws the two names apart from pools of more than two hundred each, and
 * builds a company from a made-up root and a form its country uses, which
 * gives each locale some three hundred and sixty companies, none of them a
 * real one.
 *
 * Kept as words, one name per word: a name of two words would be read as
 * two names.
 */

import type { SupportedLocale } from './LocaleData.js';

/** The words of a block of text, each one a name. */
function words(text: string): readonly string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

/** First names per locale. */
export const FIRST_NAMES: Record<SupportedLocale, readonly string[]> = {
  en_US: words(`
    Alice Bob Charlie Diana Eve Frank Grace Hank Ivy Jack Kate Leo Mia Noah Olivia
    James Mary Robert Patricia John Jennifer Michael Linda David Elizabeth William Barbara
    Richard Susan Joseph Jessica Thomas Sarah Charles Karen Christopher Lisa Daniel Nancy
    Matthew Betty Anthony Sandra Mark Margaret Donald Ashley Steven Kimberly Andrew Emily
    Paul Donna Joshua Michelle Kenneth Carol Kevin Amanda Brian Melissa George Deborah
    Timothy Stephanie Ronald Dorothy Jason Rebecca Edward Sharon Jeffrey Laura Ryan Cynthia
    Jacob Amy Gary Kathleen Nicholas Angela Eric Shirley Jonathan Brenda Stephen Emma Larry
    Anna Justin Pamela Scott Nicole Brandon Samantha Benjamin Katherine Samuel Christine
    Gregory Helen Alexander Debra Patrick Rachel Carolyn Raymond Janet Maria Dennis
    Catherine Jerry Heather Tyler Aaron Julie Adam Joyce Nathan Victoria Henry Ruth
    Zachary Virginia Douglas Lauren Peter Kelly Kyle Christina Ethan Evelyn Jeremy Judith
    Walter Andrea Christian Hannah Keith Megan Roger Cheryl Terry Jacqueline Austin Martha
    Sean Madison Gerald Teresa Carl Gloria Harold Sara Dylan Janice Arthur Ann Lawrence
    Kathryn Jordan Abigail Jesse Sophia Bryan Frances Billy Jean Bruce Gabriel Judy Joe
    Isabella Logan Julia Alan Juan Amber Albert Denise Willie Danielle Elijah
    Marilyn Wayne Beverly Randy Charlotte Vincent Natalie Mason Theresa Roy Ralph
    Brittany Bobby Doris Russell Kayla Bradley Alexis Philip Lori Eugene Marie Owen Chloe
  `),
  fr_FR: words(`
    Marie Pierre Jean Sophie Nicolas Camille Julien Léa Thomas Emma Lucas Chloé Hugo Manon
    Antoine Louis Jade Gabriel Louise Arthur Alice Raphaël Lina Jules Rose Adam Anna Paul
    Ambre Léo Juliette Victor Inès Nathan Mila Mathis Zoé Théo Lucie Maxime Clara Alexandre
    Sarah Romain Laura Mathieu Pauline Guillaume Marion Sébastien Céline Vincent Isabelle
    François Nathalie Laurent Sandrine Olivier Valérie Christophe Stéphanie Philippe
    Catherine Michel Christine Alain Sylvie Patrick Martine Éric Monique Frédéric Françoise
    Stéphane Anne David Véronique Benoît Hélène Jérôme Caroline Cédric Aurélie Damien Émilie
    Florian Élodie Kévin Mélanie Quentin Charlotte Bastien Margaux Clément Océane Adrien
    Justine Baptiste Mathilde Benjamin Agathe Simon Élise Valentin Noémie Martin Margot
    Robin Héloïse Tristan Capucine Corentin Apolline Gaspard Victoire Alexis Joséphine Rémi
    Constance Yann Gaëlle Loïc Solène Fabien Morgane Jérémy Audrey Thibault Amandine Arnaud
    Virginie Grégoire Delphine Xavier Laetitia Bruno Florence Denis Brigitte Gilles Danielle
    Thierry Chantal Yves Josiane Didier Annie Pascal Odile Serge Colette Hervé Jacqueline
    René Mireille Gérard Ginette Bernard Simone Claude Yvette Daniel Nicole Jacques
    Paulette Henri Jeanne André Madeleine Marcel Suzanne Roger Denise Robert Germaine
    Georges Marcelle Lucien Odette Raymond Huguette Maurice Lucienne Émile Renée Armand
    Gisèle Étienne Raymonde Léon Léonie Félix Eugénie Joseph Albertine Noé Bérénice Axel
    Tom Lou Nina Timéo Lisa Mathéo Romane Sacha
  `),
  de_DE: words(`
    Max Anna Lukas Lena Felix Marie Paul Sophia Leon Emma Jonas Mia Elias Hannah Ben Noah
    Emilia Finn Lina Luis Ella Clara Matteo Leni Emil Ida Theo Lea Anton Mila Jakob Frieda
    Moritz Lara Julian Laura Alexander Johanna Niklas Charlotte Tim Amelie Jan Leonie David
    Luisa Fabian Sarah Tobias Julia Florian Katharina Sebastian Lisa Philipp Nina Daniel
    Jana Simon Vanessa Benedikt Franziska Christian Sabine Stefan Andrea Thomas Claudia
    Michael Petra Andreas Susanne Markus Nicole Martin Stefanie Frank Monika Jürgen Birgit
    Uwe Martina Wolfgang Heike Klaus Karin Dieter Ursula Peter Renate Hans Gisela Manfred
    Ingrid Helmut Helga Gerhard Brigitte Werner Elke Rolf Christa Bernd Angelika Rainer
    Gabriele Horst Barbara Günter Silke Dirk Anja Holger Kerstin Ralf Tanja Jens Melanie
    Sven Daniela Kai Nadine Oliver Sandra Lars Bianca Torsten Christina Matthias Ines
    Carsten Simone Volker Annette Heiko Doris Marco Ute Dennis Sonja Patrick Jutta Marcel
    Karla Robin Greta Malte Mathilda Ole Paula Hannes Marlene Konstantin Pauline Vincent
    Antonia Valentin Romy Johannes Elisa Leonard Isabell Maximilian Magdalena Carl Theresa
    Oskar Helene Fritz Luise Karl Margarete Otto Hedwig Wilhelm Erna Heinrich Gertrud
    Friedrich Irmgard Hermann Hildegard Ludwig Elfriede Kurt Lieselotte Ernst Waltraud
    Walter Edith Rudolf Anneliese Bruno Rosemarie Arno Erika Lothar Marianne Norbert
    Reinhard Gottfried Henriette Jonathan Merle Till Svenja Henrik Wiebke
  `),
  es_ES: words(`
    Carlos María Alejandro Carmen Javier Lucía Miguel Marta Daniel Ana Pablo Elena Diego
    Laura Sergio Antonio Isabel Manuel Pilar Francisco Dolores José Teresa David Rosa Juan
    Cristina Jesús Raquel Luis Mercedes Ángel Sara Rafael Paula Fernando Beatriz Jorge Julia
    Alberto Silvia Álvaro Patricia Adrián Irene Rubén Nuria Óscar Rocío Iván Alba Andrés
    Andrea Ramón Claudia Enrique Sofía Vicente Marina Joaquín Natalia Santiago Lorena Víctor
    Eva Mario Inmaculada Hugo Montserrat Jaime Ángela Ignacio Susana Gonzalo Yolanda Marcos
    Alicia Eduardo Concepción Guillermo Esther Emilio Victoria Ricardo Rosario Roberto
    Encarnación Tomás Noelia Salvador Verónica Agustín Lidia Gabriel Miriam Mateo Carolina
    Martín Celia Lucas Ainhoa Nicolás Nerea Samuel Estela Héctor Gloria Leo Olga Iker
    Vanesa Aitor Amparo Unai Begoña Asier Leire Xavier Jordi Pau Laia Marc Aina Arnau Clara
    Pol Mireia Bruno Valeria Darío Ximena Rodrigo Daniela Gael Carla Thiago Lola Luca Vega
    Izan Candela Marco Abril Alonso Triana Enzo Jimena Eric Alma Aitana Ian Martina
    Sebastián Emma Felipe Inés Gregorio Adela Julián Rebeca Esteban Lourdes Ernesto
    Milagros Ismael Fátima Germán Margarita Lorenzo Josefa Benito Juana Ramiro Francisca
    Arturo Antonia Aurelio Manuela Fidel Gerardo Eulalia Leandro Maite Rosalía Bernardo
    Cristian Pedro Raúl Elías Ariadna Joel Leyre Hernán Lía Saúl Mara Teo Gema Borja
    Iratxe Ander Naia Oier Amaia Jacobo
  `),
  ja_JP: words(`
    Taro Hanako Yuki Kenji Sakura Haruto Yui Sota Hina Ren Mei Kaito Aoi Riku Mio Hiroshi
    Akiko Takashi Yoko Satoshi Keiko Kazuo Michiko Makoto Naoko Daisuke Yumi Shota Ayaka
    Kenta Misaki Yusuke Nanami Takumi Haruka Ryota Saki Kazuki Miyu Hayato Rin Yuto Yuna
    Sora Koharu Minato Himari Itsuki Akari Hinata Mitsuki Asahi Tsumugi Yamato Ema Haruki
    Mai Daiki Rika Tsubasa Chihiro Kosuke Erika Tomoya Kaori Naoki Megumi Shun Ayumi Yuya
    Emi Ryo Kana Tatsuya Natsuki Shinji Asuka Hideki Eri Masato Mariko Atsushi Noriko Koji
    Sachiko Hiroki Tomoko Akira Junko Shinichi Kumiko Masaki Reiko Kyoko Kiyoshi Hiromi
    Osamu Yoshiko Tetsuya Mayumi Jun Miho Goro Chie Isamu Fumiko Ichiro Etsuko Jiro Kazuko
    Saburo Masako Shiro Setsuko Taichi Kanako Kohei Momoka Ryusei Nozomi Sho Shiori Yuma Ami
    Ryuji Rina Keita Chika Genki Honoka Kei Sayaka Masaru Yuko Nobuo Hisako Shigeru Teruko
    Susumu Kimiko Tadashi Hatsue Toru Ayano Yasuo Sumire Yoshio Kotone Mamoru Miku Minoru
    Wakana Hajime Yuzuki Noboru Kaede Takeshi Sana Hiroto Riko Kota Rena Sosuke Yuka
    Tomohiro Aya Shoma Kyoka Kaname Fuka Ryunosuke Shizuka Seiji Aiko Takahiro Hitomi
    Kunio Kazumi Haruo Kiyomi Fumio Shinobu Katsuo Tamaki Noriaki Mizuki Keisuke Mana
    Hiroyuki Ryoko Tadao Midori Kenichi Natsumi Daichi Reina Shigeo Yoshie Toshio Masao
    Harue Takao Junichi Sumiko Kengo Tomomi
  `),
  pt_BR: words(`
    Joao Ana Pedro Maria Lucas Juliana Gabriel Fernanda Rafael Camila Matheus Larissa Bruno
    Beatriz Thiago Gustavo Mariana Felipe Amanda Rodrigo Letícia Leonardo Bruna Guilherme
    Carolina Eduardo Aline Ricardo Patrícia Marcelo Vanessa Diego Natália Vinícius Jéssica
    André Renata Daniel Gabriela Carlos Isabela Paulo Luana Marcos Bianca Fábio Débora
    Leandro Tatiana Alexandre Priscila Fernando Raquel Antônio Sabrina Luiz Daniela
    Francisco Adriana José Simone Roberto Cristina Sérgio Sandra Júlio Márcia Henrique
    Cláudia Caio Viviane Samuel Elaine Igor Luciana Arthur Alessandra Heitor Valéria
    Bernardo Helena Davi Alice Miguel Laura Enzo Manuela Murilo Sophia Otávio Lívia
    Benjamin Valentina Lorenzo Heloísa Theo Cecília Nicolas Clara Pietro Eloá Joaquim
    Lorena Bento Isadora Emanuel Yasmin Raul Rebeca Cauã Agatha Breno Maitê Danilo Melissa
    Kaique Pietra Wesley Stella Wellington Rayssa Anderson Thaís Everton Kelly Jefferson
    Michele Rogério Fabiana Reinaldo Silvana Ronaldo Rosana Edson Regina Cláudio Lúcia
    Wagner Sônia Márcio Vera Mauro Rita Sílvio Denise Osvaldo Joana Gilberto Teresa Geraldo
    Aparecida Raimundo Francisca Sebastião Antônia Benedito Rosângela Valdir Marta Moacir
    Neusa Nelson Irene Jorge Célia Renato Iara Augusto Dalva Hélio Zilda Ivan Glória Alberto
    Olga Cristiano Tiago Mirela Rafaela Vitória Kauã Lara Nathan Giovanna Gael Liz Ravi
    Esther Caetano Íris Levi Aurora Noah Hugo Catarina Rui Inácio Mariah Ícaro Jade Tomás
  `),
};

/** Last names per locale. */
export const LAST_NAMES: Record<SupportedLocale, readonly string[]> = {
  en_US: words(`
    Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez
    Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez Thompson
    White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen King Wright Scott
    Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell Carter
    Roberts Gomez Phillips Evans Turner Diaz Parker Cruz Edwards Collins Reyes Stewart
    Morris Morales Murphy Cook Rogers Gutierrez Ortiz Morgan Cooper Peterson Bailey Reed
    Kelly Howard Ramos Kim Cox Ward Richardson Watson Brooks Chavez Wood James Bennett Gray
    Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross Foster Jimenez
    Powell Jenkins Perry Russell Sullivan Bell Coleman Butler Henderson Barnes Gonzales
    Fisher Vasquez Simmons Romero Jordan Patterson Alexander Hamilton Graham Reynolds
    Griffin Wallace Moreno West Cole Hayes Bryant Herrera Gibson Ellis Tran Medina Aguilar
    Stevens Murray Ford Castro Marshall Owens Harrison Fernandez McDonald Woods Washington
    Kennedy Wells Vargas Henry Chen Freeman Webb Tucker Guzman Burns Crawford Olson Simpson
    Porter Hunter Gordon Mendez Silva Shaw Snyder Mason Dixon Munoz Hunt Hicks Holmes Palmer
    Wagner Black Robertson Boyd Rose Stone Salazar Fox Warren Mills Meyer Rice Schmidt Garza
    Daniels Ferguson Nichols Stephens Soto Weaver Ryan Gardner Payne Grant Dunn Kelley
    Spencer Hawkins Arnold Pierce Vazquez Hansen Peters Santos Hart Bradley Knight Elliott
    Cunningham Duncan Armstrong Hudson Carroll Lane Riley Andrews Alvarado Ray Delgado Berry
    Perkins Hoffman Johnston Matthews Pena Richards Contreras Willis Carpenter Lawrence
  `),
  fr_FR: words(`
    Dupont Martin Bernard Dubois Thomas Robert Richard Petit Durand Leroy Moreau Simon
    Laurent Lefebvre Michel Roux David Bertrand Morel Fournier Girard Bonnet Lambert
    Fontaine Rousseau Vincent Muller Lefèvre Faure André Mercier Blanc Guérin Boyer Garnier
    Chevalier François Legrand Gauthier Garcia Perrin Robin Clément Morin Nicolas Henry
    Roussel Mathieu Gautier Masson Marchand Duval Denis Dumont Marie Lemaire Noël Meyer
    Dufour Meunier Brun Blanchard Giraud Joly Rivière Lucas Brunet Gaillard Barbier Arnaud
    Martinez Gérard Roche Renard Schmitt Roy Leroux Colin Vidal Caron Picard Roger Fabre
    Aubert Lemoine Renaud Dumas Lacroix Olivier Philippe Bourgeois Pierre Benoît Rey
    Leclerc Payet Rolland Leclercq Guillaume Lecomte Lopez Jean Dupuy Guillot Hubert Berger
    Carpentier Sanchez Dupuis Moulin Louis Deschamps Huet Vasseur Perez Boucher Fleury
    Royer Klein Jacquet Adam Paris Poirier Marty Aubry Guyot Carré Charles Renault
    Charpentier Ménard Maillard Baron Bertin Bailly Hervé Schneider Fernandez Collet Léger
    Bouvier Julien Prévost Millet Perrot Daniel Cousin Germain Breton Besson Langlois Rémy
    Pelletier Lévêque Perrier Leblanc Barré Lebrun Marchal Weber Mallet Hamon Boulanger
    Jacob Monnier Michaud Rodriguez Guichard Gillet Étienne Grondin Poulain Tessier
    Chevallier Collin Chauvin Bouchet Gay Lemaître Bénard Maréchal Humbert Reynaud Antoine
    Hoarau Perret Barthélemy Cordier Pichon Lejeune Gilbert Lamy Delaunay Pasquier Carlier
    Laporte Lebon Texier Riviere Granger Vallet Bousquet
  `),
  de_DE: words(`
    Schmidt Schneider Fischer Weber Meyer Wagner Becker Schulz Hoffmann Koch
    Richter Wolf Bauer Müller Schäfer Klein Schröder Neumann Schwarz Zimmermann
    Braun Krüger Hofmann Hartmann Lange Schmitt Werner Schmitz Krause Meier Lehmann Schmid
    Schulze Maier Köhler Herrmann König Walter Mayer Huber Kaiser Fuchs Peters Lang Scholz
    Möller Weiß Jung Hahn Schubert Vogel Friedrich Keller Günther Frank Berger Winkler Roth
    Beck Lorenz Baumann Franke Albrecht Schuster Simon Ludwig Böhm Winter Kraus Martin
    Schumacher Krämer Vogt Stein Jäger Otto Sommer Groß Seidel Heinrich Brandt Haas
    Schreiber Graf Schulte Dietrich Ziegler Kuhn Kühn Pohl Engel Horn Busch Bergmann Thomas
    Voigt Sauer Arnold Wolff Pfeiffer Ernst Lindner Franz Böttcher Beyer Seifert Fritz
    Hübner Kurz Kessler Kraft Jansen Ritter Wenzel Mertens Thiel Gerlach Ulrich Brinkmann
    Naumann Böhme Busse Riedel Kolb Herzog Schütz Hesse Wendt Stark Schwab Martens Arndt
    Rieger Schilling Zander Hartung Brandl Kirchner Steiner Marx Hauser Fiedler Reuter
    Kramer Petersen Wirth Heinz Moser Funk Bender Thomsen Dittrich Pieper Kunz Schenk
    Bach Witt Kuhlmann Lehner Weise Benz Paul Sander Vetter Ackermann Engelhardt
    Harms Hagen Unger Seitz Maurer Bayer Reichert Frey Specht Nagel Roder
    Ebert Siebert Bock Hein Kunze Jahn Wegner Otte Kaufmann Hermann Rothe Reinhardt Wiese
    Freitag Pape Schott Dorn Nowak Ott Lohmann Beckmann Fröhlich Rösler Scherer Görtz
  `),
  es_ES: words(`
    García Rodríguez González Fernández López Martínez Sánchez Pérez Gómez Martín Jiménez
    Ruiz Hernández Díaz Moreno Muñoz Álvarez Romero Alonso Gutiérrez Navarro Torres
    Domínguez Vázquez Ramos Gil Ramírez Serrano Blanco Molina Morales Suárez Ortega Delgado
    Castro Ortiz Rubio Marín Sanz Núñez Iglesias Medina Garrido Cortés Castillo Santos
    Lozano Guerrero Cano Prieto Méndez Cruz Calvo Gallego Vidal León Márquez Herrera Peña
    Flores Cabrera Campos Vega Fuentes Carrasco Diez Caballero Reyes Nieto Aguilar Pascual
    Santana Herrero Lorenzo Montero Hidalgo Giménez Ibáñez Ferrer Durán Santiago Benítez
    Mora Vicente Vargas Arias Carmona Crespo Román Pastor Soto Sáez Velasco Moya Soler Parra
    Esteban Bravo Gallardo Rojas Pardo Merino Franco Espinosa Izquierdo Lara Rivas Silva
    Rivera Casado Arroyo Redondo Camacho Rey Vera Otero Luque Galán Montes Ríos Sierra
    Segura Carrillo Marcos Soriano Mendoza Robles Bernal Vila Valero Palacios Benito
    Pereira Vallejo Varela Expósito Andrés Guerra Bueno Mateo Villar Miranda Contreras
    Mateos Aguilera Hurtado Rosa Ibarra Paredes Heredia Calderón Escobar Salazar Toledo
    Cuesta Beltrán Salas Rico Plaza Ávila Pacheco Rueda Cordero Quintana Gracia Polo Fajardo
    Manzano Rosales Tapia Barrera Acosta Bermúdez Cabello Valencia Peinado Mesa Duarte
    Maldonado Rincón Figueroa Zamora Benavides Cisneros Ochoa Trujillo Salinas Villalobos
    Barrios Escudero Sosa Andrade Guzmán Osorio Fuster Pons Mir Roca Casas Puig Alarcón
  `),
  ja_JP: words(`
    Tanaka Suzuki Takahashi Watanabe Ito Yamamoto Nakamura Kobayashi Kato Yoshida Yamada
    Sasaki Yamaguchi Matsumoto Inoue Sato Kimura Hayashi Shimizu Yamazaki Mori Abe Ikeda
    Hashimoto Yamashita Ishikawa Nakajima Maeda Fujita Ogawa Goto Okada Hasegawa Murakami
    Kondo Ishii Saito Sakamoto Endo Aoki Fujii Nishimura Fukuda Ota Miura Fujiwara Okamoto
    Matsuda Nakagawa Nakano Harada Ono Tamura Takeuchi Kaneko Wada Nakayama Ishida Ueda
    Morita Hara Shibata Sakai Kudo Yokoyama Miyazaki Miyamoto Uchida Takagi Ando Taniguchi
    Ohno Maruyama Imai Takada Fujimoto Takeda Murata Ueno Sugiyama Masuda Sugawara Hirano
    Otsuka Chiba Kubo Matsui Iwasaki Sakurai Kinoshita Noguchi Matsuo Kikuchi Nomura Arai
    Sano Onishi Sugimoto Hamada Ichikawa Furukawa Mizuno Komatsu Shimada Igarashi Kojima
    Takano Taguchi Kitamura Yasuda Nakanishi Kawaguchi Hirata Kawasaki Iida Yoshikawa
    Kubota Sawada Tsuji Seki Yoshimura Iwata Nakazawa Iwamoto Kawakami Sakaguchi Morimoto
    Kuroda Hattori Higuchi Fukushima Nagai Matsuoka Akiyama Kitagawa Okazaki Tsuchiya
    Hoshino Kawamura Takayama Hirai Tani Miyake Kanno Oshima Ochiai Kamata Hamaguchi
    Nishida Nishikawa Okuda Ozawa Matsumura Murayama Shimomura Tsukamoto Takemoto Hino
    Mochizuki Hirose Kumagai Azuma Hagiwara Okubo Nagata Hiraoka Kuwahara Kurosawa Amano
    Oda Sekiguchi Yagi Nishiyama Ichinose Kono Asano Tsuda Minami Tsutsumi Oyama Yano
    Kawabata Doi Mizutani Ozaki Shinohara Wakabayashi Ishihara Nakata Iwai Onodera Saeki
    Kishi Fujisawa Fukui Hosokawa Kagawa Kamiya Nakatani Kanazawa Morikawa Hayakawa
    Nagasawa Shiraishi Takamura
  `),
  pt_BR: words(`
    Silva Santos Oliveira Souza Rodrigues Ferreira Alves Pereira Lima Gomes Costa Ribeiro
    Martins Carvalho Almeida Lopes Soares Fernandes Vieira Barbosa Rocha Dias Nascimento
    Andrade Moreira Nunes Marques Machado Mendes Freitas Cardoso Ramos Gonçalves Santana
    Teixeira Araújo Correia Monteiro Pinto Cavalcanti Batista Moura Campos Castro Cunha
    Duarte Farias Melo Reis Azevedo Barros Borges Brito Cruz Fonseca Leite Macedo Medeiros
    Miranda Morais Nogueira Pires Rezende Sales Siqueira Tavares Viana Xavier Aguiar Amaral
    Antunes Bezerra Braga Bueno Caldeira Coelho Dantas Diniz Esteves Figueiredo Franco
    Guimarães Jesus Lacerda Leal Magalhães Maia Matos Meireles Neves Pacheco Paiva Peixoto
    Prado Queiroz Rangel Rios Sampaio Seixas Serra Toledo Valente Vasconcelos Vaz Amorim
    Assis Bastos Cabral Calado Camargo Carneiro Chaves Couto Faria Feitosa Frota Galvão
    Garcia Godoy Holanda Lins Lobo Luz Maciel Mattos Mesquita Mota Novaes Pimentel Porto
    Ribas Salgado Sobral Telles Torres Uchoa Veloso Vilela Arruda Brandão Damasceno
    Evangelista Falcão Fontes Freire Guerra Lustosa Marinho Mourão Paes Paixão Rosa
    Saraiva Simões Barreto Bittencourt Cordeiro Cerqueira Coutinho Fagundes Gusmão Leme
    Lessa Mascarenhas Montenegro Muniz Nóbrega Pedrosa Peres Quaresma Rabelo Rebouças
    Sena Sodré Tenório Valadares Varela Vidal Zanetti Resende Moraes Aragão Bragança
    Medina Brum Fraga Goulart Lage Linhares Motta Nobre Pessoa Quintela Sarmento Tomé
    Vargas Werneck Ximenes Zago Carmo Dutra Gouveia Albuquerque
  `),
};

/**
 * The made-up roots a company is named from, per locale, which read as the
 * locale's and belong to no company anyone knows.
 */
const COMPANY_ROOTS: Record<SupportedLocale, readonly string[]> = {
  en_US: words(`
    Brantwell Corvane Halbrook Pellridge Quinmore Ashcombe Dunmore Everhart Glenwick
    Harrowgate Ironvale Kestrelby Larkhaven Marlowick Northvale Oakhurst Pinecrest Thornbury
    Upwell Vantor Wexley Yarrowby Zellmore Calloway Ellsworth Fenwick Stonebrook Wrenfield
    Hartwell Bramblecote
  `),
  fr_FR: words(`
    Vercourt Lambrecq Dufrenois Morvanel Gaudrière Pelvoisin Varennel Hautemer Roussillac
    Belcombe Chantelys Daumerac Fontclaire Joscaret Kervalec Lormanges Montbriel Navarrel
    Orsenac Pradelis Quercyval Rivecourt Sablonnay Taverlac Valbrune Bressolles Cardinet
    Dorvigny Escaloux Saint-Aubrac
  `),
  de_DE: words(`
    Kaltenbrunn Elbtaler Brennecke Auenfeld Steinhagel Mühlenkamp Hollerbach Rabenstein
    Lindwurm Ostwald Achterberg Dornfeld Fallerstein Grimmelhof Haselbrink Ilmenhorst
    Kornbach Lohwinkel Moorbeck Quellental Rothenwald Sandhagen Tannreuth Wiesengrund
    Zwieselbrock Uhlenbrook Velmering Weidenkamp Brackwede Elsterhain
  `),
  es_ES: words(`
    Albarrán Valdeoro Guadalmar Peñalvar Riberalta Castellmar Arroyuelo Sotomonte
    Puertoalba Encinar Alcorvia Berrocalia Doramonte Escalverde Fontanar Garrobal Hontalba
    Lucenar Navalcruz Olmedal Pradoalto Robledal Torreluz Valcorba Almendrar Cortijuela
    Jaramonte Linarejo Montejara Sauceda
  `),
  ja_JP: words(`
    Kawabe Midorigawa Hoshizora Kirisame Shirakaba Tsukinowa Hanamizuki Kuroiwa Minatogawa
    Yamabuki Aozora Fuyumori Hikarizaka Isonami Kazahana Momijidani Natsukawa Oboro
    Sakuragi Tobiume Umibe Yukishiro Akanegumo Hotaruno Kiribayashi Shiokaze Tsurugaoka
    Yuugiri Komorebi Asagiri
  `),
  pt_BR: words(`
    Barrocal Verdejo Ribeirinha Aroeira Morroazul Cajuína Jaboticaba Taquaral Ipêzal
    Pindorama Buritizal Carnaubal Jacarandá Mangueiral Palmeiral Quixabeira Sapucaia
    Tamboril Umbuzeiro Vereda Cambuí Ingazeira Seriguela Araçá Goiabal Pitangueira
    Juremal Angical Cajazeira Oiticica
  `),
};

/**
 * The forms a company of the locale's country takes, `{root}` standing for
 * its root: a suffix of trade or legal form, or a trade in front.
 */
const COMPANY_FORMS: Record<SupportedLocale, readonly string[]> = {
  en_US: [
    '{root} Industries',
    '{root} Labs',
    '{root} Systems',
    '{root} Logistics',
    '{root} Foods',
    '{root} Analytics',
    '{root} Partners',
    '{root} Holdings',
    '{root} Manufacturing',
    '{root} Health',
    '{root} Energy',
    '{root} Software',
  ],
  fr_FR: [
    'Groupe {root}',
    'Ateliers {root}',
    '{root} SAS',
    'Laboratoires {root}',
    'Transports {root}',
    '{root} Conseil',
    'Maison {root}',
    'Cabinet {root}',
    '{root} Industries',
    'Comptoir {root}',
    'Optique {root}',
    'Brasseries {root}',
  ],
  de_DE: [
    '{root} GmbH',
    '{root} AG',
    '{root} Maschinenbau GmbH',
    '{root} Logistik AG',
    '{root} & Partner',
    '{root} Software GmbH',
    '{root} Bau GmbH',
    '{root} Elektrotechnik',
    '{root} Feinkost',
    '{root} Versicherung AG',
    '{root} Chemie AG',
    '{root} Medizintechnik',
  ],
  es_ES: [
    'Grupo {root}',
    'Construcciones {root}',
    'Transportes {root}',
    'Bodegas {root}',
    'Seguros {root}',
    'Ingeniería {root}',
    'Laboratorios {root}',
    '{root} S.L.',
    'Aceites {root}',
    'Textiles {root}',
    'Conservas {root}',
    'Distribuciones {root}',
  ],
  ja_JP: [
    '{root} Shoji',
    '{root} Denki',
    '{root} Kogyo',
    '{root} Seimitsu',
    '{root} Foods',
    '{root} Logistics',
    '{root} Sangyo',
    '{root} Kensetsu',
    '{root} Shoken',
    '{root} Software',
    '{root} Seiyaku',
    '{root} Tsusho',
  ],
  pt_BR: [
    'Construtora {root}',
    'Grupo {root}',
    'Transportadora {root}',
    'Laticínios {root}',
    'Tecelagem {root}',
    'Seguradora {root}',
    'Farmácias {root}',
    'Metalúrgica {root}',
    '{root} Ltda',
    'Café {root}',
    'Bioquímica {root}',
    'Distribuidora {root}',
  ],
};

/**
 * The streets of a locale and how its addresses write a number on one:
 * `{n}` the house number, `{m}` a second number where the locale has one.
 * Every locale wrote an American street — "104 Oak Ave, Lyon".
 */
export const STREETS: Record<SupportedLocale, { names: readonly string[]; format: string }> = {
  en_US: {
    names: [
      'Main St',
      'Oak Ave',
      'Elm St',
      'Park Blvd',
      'Cedar Ln',
      'Maple Dr',
      'Pine St',
      'Lake Rd',
      'Hill St',
      'River Rd',
      'Washington Ave',
      'Sunset Blvd',
    ],
    format: '{n} {street}',
  },
  fr_FR: {
    names: [
      'rue de la République',
      'avenue Jean Jaurès',
      'rue Victor Hugo',
      'boulevard Pasteur',
      'rue des Lilas',
      'place de la Mairie',
      'rue du Moulin',
      'avenue de la Gare',
      'rue Nationale',
      'chemin des Vignes',
      'rue des Écoles',
      'allée des Tilleuls',
    ],
    format: '{n} {street}',
  },
  de_DE: {
    names: [
      'Hauptstraße',
      'Bahnhofstraße',
      'Gartenweg',
      'Schulstraße',
      'Lindenallee',
      'Bergstraße',
      'Kirchplatz',
      'Mühlenweg',
      'Dorfstraße',
      'Am Markt',
      'Rosenstraße',
      'Waldweg',
    ],
    format: '{street} {n}',
  },
  es_ES: {
    names: [
      'Calle Mayor',
      'Avenida de la Constitución',
      'Calle Real',
      'Plaza de España',
      'Calle del Sol',
      'Calle Nueva',
      'Avenida del Mar',
      'Calle San José',
      'Camino Viejo',
      'Calle de la Iglesia',
      'Paseo del Prado',
      'Calle Alta',
    ],
    format: '{street} {n}',
  },
  ja_JP: {
    names: [
      'Chuo',
      'Honcho',
      'Sakaecho',
      'Midorimachi',
      'Asahicho',
      'Motomachi',
      'Saiwaicho',
      'Higashi',
      'Kitamachi',
      'Minamicho',
      'Nishiki',
      'Hanazono',
    ],
    format: '{m}-{n} {street}',
  },
  pt_BR: {
    names: [
      'Rua das Flores',
      'Avenida Brasil',
      'Rua São João',
      'Rua XV de Novembro',
      'Rua da Paz',
      'Rua Sete de Setembro',
      'Avenida Central',
      'Rua do Comércio',
      'Travessa da Lapa',
      'Rua das Palmeiras',
      'Avenida Atlântica',
      'Rua Tiradentes',
    ],
    format: '{street}, {n}',
  },
};

/**
 * The regions of a locale's country a company's branch is named after, past
 * the locale's own companies: the same root and form with a region beside
 * the root, as the regional company of a group reads ("Brantwell Pacific
 * Logistics", "Groupe Vercourt Ouest", "Kaltenbrunn Nord GmbH").
 */
const COMPANY_REGIONS: Record<SupportedLocale, readonly string[]> = {
  en_US: ['Pacific', 'Midwest', 'Atlantic', 'Southwest', 'Northeast', 'Gulf'],
  fr_FR: ['Ouest', 'Est', 'Sud', 'Nord', 'Centre', 'Atlantique'],
  de_DE: ['Nord', 'Süd', 'West', 'Ost', 'Mitte', 'Rhein'],
  es_ES: ['Norte', 'Sur', 'Levante', 'Centro', 'Atlántico', 'Mediterráneo'],
  ja_JP: ['Kanto', 'Kansai', 'Kyushu', 'Tohoku', 'Chubu', 'Hokuriku'],
  pt_BR: ['Sul', 'Nordeste', 'Norte', 'Centro-Oeste', 'Sudeste', 'Litoral'],
};

/**
 * The company at `index` of a locale's list ({@link companiesOf}), dealt for
 * the `round`-th time: its own name in the first round, then its root beside
 * a region of the country, one region a round, then numbered once every
 * region has been used. No two (index, round) give the same name.
 *
 * Five hundred accounts got the locale's 360 companies and then 140 of them
 * again: the list came round, and an org held two "Brantwell Logistics".
 */
export function companyAt(locale: SupportedLocale, index: number, round = 0): string {
  const roots = COMPANY_ROOTS[locale];
  const forms = COMPANY_FORMS[locale];
  const root = roots[index % roots.length];
  const form = forms[Math.floor(index / roots.length) % forms.length];
  if (round === 0) return form.replace('{root}', root);
  const regions = COMPANY_REGIONS[locale];
  const region = regions[(round - 1) % regions.length];
  const branch = form.replace('{root}', `${root} ${region}`);
  const lap = Math.floor((round - 1) / regions.length);
  return lap === 0 ? branch : `${branch} ${lap + 1}`;
}

/**
 * Every company a locale names: each root in each form, root by root, so
 * that companies next to each other in the list do not share a root.
 */
export function companiesOf(locale: SupportedLocale): readonly string[] {
  const count = COMPANY_FORMS[locale].length * COMPANY_ROOTS[locale].length;
  return Array.from({ length: count }, (_, index) => companyAt(locale, index));
}
